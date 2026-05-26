import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import {
  HistoryFilters,
  buildClosedTicketsWhere,
  ticketHistoryIncludes,
  serializeSession,
  filterTicketsByAccess
} from "./closedTicketsHistoryHelper";

interface Request extends HistoryFilters {
  pageNumber?: string;
  groupBy?: string;
}

export interface ContactGroup {
  contact: Contact;
  sessions: ReturnType<typeof serializeSession>[];
  lastFinishedAt: Date | string;
  totalSessions: number;
  whatsappNames: string[];
}

interface Response {
  groups?: ContactGroup[];
  tickets?: ReturnType<typeof serializeSession>[];
  count: number;
  hasMore: boolean;
}

const ListClosedTicketsHistoryService = async ({
  pageNumber = "1",
  groupBy = "contact",
  ...filters
}: Request): Promise<Response> => {
  const page = Math.max(1, +pageNumber || 1);
  const limit = groupBy === "contact" ? 30 : 40;
  const offset = limit * (page - 1);

  const whereCondition = await buildClosedTicketsWhere(filters);
  if ((whereCondition as { id?: number }).id === -1) {
    return groupBy === "contact"
      ? { groups: [], count: 0, hasMore: false }
      : { tickets: [], count: 0, hasMore: false };
  }

  let includes = ticketHistoryIncludes();
  if (filters.searchParam?.trim()) {
    includes = includes.map((inc: { as?: string }) =>
      inc.as === "contact" ? { ...inc, required: true } : inc
    );
  }

  const { count, rows } = await Ticket.findAndCountAll({
    where: whereCondition,
    include: includes,
    order: [["updatedAt", "DESC"]],
    distinct: true
  });

  const accessible = filterTicketsByAccess(rows, filters.user);

  if (groupBy === "contact") {
    const groupsMap = new Map<number, ContactGroup>();

    accessible.forEach((ticket) => {
      const cid = ticket.contactId;
      if (!cid) return;

      if (!groupsMap.has(cid)) {
        groupsMap.set(cid, {
          contact: ticket.contact,
          sessions: [],
          lastFinishedAt: ticket.updatedAt,
          totalSessions: 0,
          whatsappNames: []
        });
      }

      const group = groupsMap.get(cid)!;
      const session = serializeSession(ticket);
      group.sessions.push(session);
      group.totalSessions += 1;

      const wName = ticket.whatsapp?.name;
      if (wName && !group.whatsappNames.includes(wName)) {
        group.whatsappNames.push(wName);
      }

      if (new Date(session.finishedAt) > new Date(group.lastFinishedAt)) {
        group.lastFinishedAt = session.finishedAt;
      }
    });

    const allGroups = Array.from(groupsMap.values()).sort(
      (a, b) =>
        new Date(b.lastFinishedAt).getTime() - new Date(a.lastFinishedAt).getTime()
    );

    const totalGroups = allGroups.length;
    const groups = allGroups.slice(offset, offset + limit);

    return {
      groups,
      count: totalGroups,
      hasMore: offset + limit < totalGroups
    };
  }

  const tickets = accessible
    .slice(offset, offset + limit)
    .map(serializeSession);

  return {
    tickets,
    count: accessible.length,
    hasMore: offset + limit < accessible.length
  };
};

export default ListClosedTicketsHistoryService;
