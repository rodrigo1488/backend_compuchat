/**
 * Retorna o JID de destino para envio de mensagens a partir de um ticket.
 * Use esta função sempre que for enviar mensagem para um ticket (grupo ou privado).
 *
 * - Em grupos: retorna o JID do grupo (groupContact.number@g.us ou contact.number@g.us).
 * - Em privado: retorna o JID do contato (contact.number@s.whatsapp.net).
 */
export const getChatJid = (ticket: {
  contact: { number: string };
  isGroup: boolean;
  groupContact?: { number: string } | null;
}): string => {
  if (ticket.isGroup && ticket.groupContact) {
    return `${ticket.groupContact.number}@g.us`;
  }
  return `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
};
