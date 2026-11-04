export type Provider = 'evolution' | 'waha';
export type MessageKind = 'text' | 'audio' | 'video' | 'media' | 'other';

export interface NormalizedMessage {
  provider: Provider;
  instance: string;
  remoteJid: string;
  externalMessageId: string;
  sentAt: Date;
  senderJid: string;
  senderName: string;
  fromMe: boolean;
  kind: MessageKind;
  text: string;
  media: Record<string, unknown>;
  audioBase64: string | null;
  videoBase64: string | null;
  mediaBase64: string | null;
}

export interface ParseResult {
  eventAccepted: boolean;
  messages: NormalizedMessage[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pickString(...values: unknown[]): string {
  return values.map(stringValue).find(Boolean) ?? '';
}

function epochDate(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return epochDate(numeric);
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function evolutionText(message: Record<string, unknown>): string {
  const extended = asRecord(message.extendedTextMessage);
  const image = asRecord(message.imageMessage);
  const video = asRecord(message.videoMessage);
  const document = asRecord(message.documentMessage);
  const button = asRecord(message.buttonsResponseMessage);
  const list = asRecord(message.listResponseMessage);
  const ephemeral = asRecord(asRecord(message.ephemeralMessage).message);
  if (Object.keys(ephemeral).length) return evolutionText(ephemeral);
  return pickString(
    message.conversation,
    extended.text,
    image.caption,
    video.caption,
    document.caption,
    button.selectedDisplayText,
    list.title
  );
}

function evolutionMessage(instance: string, item: unknown): NormalizedMessage | null {
  const data = asRecord(item);
  const key = asRecord(data.key);
  const remoteJid = stringValue(key.remoteJid);
  const externalMessageId = stringValue(key.id);
  if (!remoteJid || !externalMessageId) return null;

  const message = asRecord(data.message);
  const audio = asRecord(message.audioMessage);
  const image = asRecord(message.imageMessage);
  const video = asRecord(message.videoMessage);
  const document = asRecord(message.documentMessage);
  const media = asRecord(data.media ?? data.mediaMessage);
  const base64 = pickString(data.base64, message.base64, audio.base64, media.base64);
  const messageType = stringValue(data.messageType).toLowerCase();
  const isAudio = messageType.includes('audio') || Object.keys(audio).length > 0;
  const mimeType = pickString(media.mimetype, audio.mimetype, image.mimetype, video.mimetype, document.mimetype);
  const isVideo = !isAudio && (
    messageType.includes('video') || mimeType.toLowerCase().startsWith('video/') || Object.keys(video).length > 0
  );
  const hasMedia = isAudio || isVideo || Object.keys(image).length > 0 ||
    Object.keys(document).length > 0 || Object.keys(media).length > 0;
  const mediaDetails = { ...media };
  delete mediaDetails.base64;

  return {
    provider: 'evolution',
    instance,
    remoteJid,
    externalMessageId,
    sentAt: epochDate(data.messageTimestamp ?? data.timestamp),
    senderJid: pickString(key.participant, key.participantAlt, data.participant),
    senderName: pickString(data.pushName, data.senderName),
    fromMe: key.fromMe === true,
    kind: isAudio ? 'audio' : isVideo ? 'video' : hasMedia ? 'media' : evolutionText(message) ? 'text' : 'other',
    text: evolutionText(message),
    media: {
      ...mediaDetails,
      mimetype: mimeType,
      fileName: pickString(media.fileName, media.filename, data.fileName),
      url: pickString(media.url, data.mediaUrl, audio.url, image.url, video.url, document.url),
      messageType
    },
    audioBase64: isAudio ? base64 || null : null,
    videoBase64: isVideo ? pickString(data.base64, message.base64, video.base64, media.base64) || null : null,
    mediaBase64: !isAudio && !isVideo
      ? pickString(data.base64, message.base64, image.base64, document.base64, media.base64) || null
      : null
  };
}

function wahaMessage(session: string, item: unknown): NormalizedMessage | null {
  const event = asRecord(item);
  const payload = asRecord(event.payload);
  const externalMessageId = stringValue(payload.id);
  const fromMe = payload.fromMe === true;
  const from = stringValue(payload.from);
  const to = stringValue(payload.to);
  const dataKey = asRecord(asRecord(payload._data).key);
  const chatId = stringValue(payload.chatId);
  const keyRemoteJid = stringValue(dataKey.remoteJid);
  const keyRemoteJidAlt = stringValue(dataKey.remoteJidAlt);
  const directedJid = fromMe ? to : from;
  const primaryJid = pickString(chatId, keyRemoteJid, directedJid, from, to);
  const normalizeJid = (jid: string) => jid.endsWith('@s.whatsapp.net')
    ? `${jid.slice(0, -'@s.whatsapp.net'.length)}@c.us`
    : jid;
  // NOWEB may expose a direct chat as @lid in the message fields while its
  // alternate JID is the phone based ID used by /chats/overview. Use that
  // alias only when WAHA supplied it alongside the same primary remote JID.
  // Group IDs take precedence because their alternate JID can belong to a member.
  const groupJid = [chatId, keyRemoteJid, directedJid, from, to].find((jid) => jid.endsWith('@g.us'));
  const pairedAlternate = primaryJid.endsWith('@lid') && keyRemoteJid === primaryJid
    ? keyRemoteJidAlt
    : '';
  const remoteJid = groupJid
    ? normalizeJid(groupJid)
    : normalizeJid(pairedAlternate || primaryJid);
  if (!remoteJid || !externalMessageId) return null;

  const media = asRecord(payload.media);
  const mimetype = stringValue(media.mimetype);
  const isAudio = mimetype.toLowerCase().startsWith('audio/') ||
    /audio|ptt|voice/i.test(stringValue(payload.type));
  const isVideo = !isAudio && (mimetype.toLowerCase().startsWith('video/') || /video/i.test(stringValue(payload.type)));
  const hasMedia = payload.hasMedia === true || Object.keys(media).length > 0;
  return {
    provider: 'waha',
    instance: session,
    remoteJid,
    externalMessageId,
    sentAt: epochDate(payload.timestamp),
    senderJid: pickString(payload.participant, fromMe ? from : ''),
    senderName: pickString(payload.pushName, event.me && asRecord(event.me).pushName),
    fromMe,
    kind: isAudio ? 'audio' : isVideo ? 'video' : hasMedia ? 'media' : stringValue(payload.body) ? 'text' : 'other',
    text: stringValue(payload.body),
    media: {
      url: stringValue(media.url),
      mimetype,
      fileName: pickString(media.filename, media.fileName),
      hasMedia
    },
    audioBase64: isAudio ? pickString(payload.base64, media.base64) || null : null,
    videoBase64: isVideo ? pickString(payload.base64, media.base64) || null : null,
    mediaBase64: !isAudio && !isVideo ? pickString(payload.base64, media.base64) || null : null
  };
}

export function parseWebhook(provider: Provider, body: unknown): ParseResult {
  const root = asRecord(body);
  const eventName = stringValue(root.event).toLowerCase().replaceAll('_', '.');
  if (provider === 'waha') {
    if (eventName !== 'message' && eventName !== 'message.any') {
      return { eventAccepted: false, messages: [] };
    }
    const session = pickString(root.session, root.instance, root.instanceName);
    if (!session) throw new Error('Evento WAHA sem session');
    return { eventAccepted: true, messages: [wahaMessage(session, body)].filter(isPresent) };
  }

  if (!['messages.upsert', 'send.message'].includes(eventName)) {
    return { eventAccepted: false, messages: [] };
  }
  const instance = pickString(root.instance, root.instanceName);
  if (!instance) throw new Error('Evento Evolution sem instance');
  const data = root.data;
  const items = Array.isArray(data) ? data : [data];
  return {
    eventAccepted: true,
    messages: items.map((item) => evolutionMessage(instance, item)).filter(isPresent)
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export function normalizeDemandTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
