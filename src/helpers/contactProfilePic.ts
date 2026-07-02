const fallbackProfilePicUrl = (): string =>
  `${process.env.FRONTEND_URL || ""}/nopicture.png`;

export const isWhatsAppCdnProfileUrl = (url?: string | null): boolean =>
  !!url &&
  (url.includes("pps.whatsapp.net") ||
    url.includes("mmg.whatsapp.net") ||
    /whatsapp\.net\/v\//.test(url));

export const isLocalContactProfileUrl = (url?: string | null): boolean =>
  !!url && url.includes("/public/contacts/");

/** URLs do CDN do WhatsApp expiram — não devem ir para o frontend. */
export const sanitizeContactProfilePicUrl = (
  url?: string | null
): string => {
  if (!url || url.trim() === "") {
    return fallbackProfilePicUrl();
  }
  if (url.includes("nopicture")) {
    return url;
  }
  if (isWhatsAppCdnProfileUrl(url)) {
    return fallbackProfilePicUrl();
  }
  return url;
};

export { fallbackProfilePicUrl };

export const sanitizeTicketContactPic = <T extends { contact?: { profilePicUrl?: string | null } }>(
  ticket: T
): T => {
  if (!ticket?.contact?.profilePicUrl) {
    return ticket;
  }
  return {
    ...ticket,
    contact: {
      ...ticket.contact,
      profilePicUrl: sanitizeContactProfilePicUrl(ticket.contact.profilePicUrl)
    }
  };
};
