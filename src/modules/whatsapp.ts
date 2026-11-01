export type Provider = 'evolution' | 'waha';
export type MessageKind = 'text' | 'audio' | 'media' | 'other';

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
  const hasMedia = isAudio || Object.keys(image).length > 0 || Object.keys(video).length > 0 ||
    Object.keys(document).length > 0 || Object.keys(media).length > 0;

  return {
    provider: 'evolution',
    instance,
    remoteJid,
    externalMessageId,
    sentAt: epochDate(data.messageTimestamp ?? data.timestamp),
    senderJid: pickString(key.participant, key.participantAlt, data.participant),
    senderName: pickString(data.pushName, data.senderName),
    fromMe: key.fromMe === true,
    kind: isAudio ? 'audio' : hasMedia ? 'media' : evolutionText(message) ? 'text' : 'other',
    text: evolutionText(message),
    media: {
      ...media,
      mimetype: pickString(media.mimetype, audio.mimetype, image.mimetype, video.mimetype, document.mimetype),
      fileName: pickString(media.fileName, media.filename, data.fileName),
      url: pickString(media.url, data.mediaUrl),
      messageType
    },
    audioBase64: base64 || null
  };
}

function wahaMessage(session: string, item: unknown): NormalizedMessage | null {
  const event = asRecord(item);
  const payload = asRecord(event.payload);
  const externalMessageId = stringValue(payload.id);
  const fromMe = payload.fromMe === true;
  const from = stringValue(payload.from);
  const to = stringValue(payload.to);
  const remoteJid = pickString(payload.chatId, fromMe ? to : from, from, to);
  if (!remoteJid || !externalMessageId) return null;

  const media = asRecord(payload.media);
  const mimetype = stringValue(media.mimetype);
  const isAudio = mimetype.toLowerCase().startsWith('audio/') ||
    /audio|ptt|voice/i.test(stringValue(payload.type));
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
    kind: isAudio ? 'audio' : hasMedia ? 'media' : stringValue(payload.body) ? 'text' : 'other',
    text: stringValue(payload.body),
    media: {
      url: stringValue(media.url),
      mimetype,
      fileName: pickString(media.filename, media.fileName),
      hasMedia
    },
    audioBase64: pickString(payload.base64, media.base64) || null
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
