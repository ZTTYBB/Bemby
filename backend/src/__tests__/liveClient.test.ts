// Unit tests for tg/liveClient.ts
// Covers entity helpers, client lifecycle, message ops, contacts, search, and pub/sub.
// vi.hoisted ensures mock classes are available inside the vi.mock() factory.

const {
  MockUser, MockChat, MockChannel,
  MockPeerUser, MockPeerChannel, MockPeerChat,
  MockMessageMediaPhoto, MockMessageMediaDocument, MockReplyInlineMarkup,
  MockTelegramClient, mockClientInstance,
  mockAddEventHandler, mockGetDialogs, mockGetMessages, mockSendMessage, mockInvoke,
} = vi.hoisted(() => {
  class MockUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChat { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockChannel { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerUser { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerChannel { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockPeerChat { constructor(d: Record<string, any>) { Object.assign(this, d); } }
  class MockMessageMediaPhoto {}
  class MockMessageMediaDocument {}
  class MockReplyInlineMarkup {
    rows: Array<{ buttons: Array<{ text: string }> }>;
    constructor(d: any) { this.rows = d.rows; }
  }

  const mockAddEventHandler = vi.fn();
  const mockGetDialogs      = vi.fn().mockResolvedValue([]);
  const mockGetMessages     = vi.fn().mockResolvedValue([]);
  const mockSendMessage     = vi.fn().mockResolvedValue({ id: 1, date: 1700000000 });
  const mockInvoke          = vi.fn().mockResolvedValue({ users: [], chats: [] });

  const mockClientInstance = {
    connect:         vi.fn().mockResolvedValue(undefined),
    connected:       true,
    addEventHandler: mockAddEventHandler,
    getDialogs:      mockGetDialogs,
    getMessages:     mockGetMessages,
    sendMessage:     mockSendMessage,
    invoke:          mockInvoke,
    downloadMedia:   vi.fn(),
  };

  const MockTelegramClient = vi.fn().mockReturnValue(mockClientInstance);

  return {
    MockUser, MockChat, MockChannel,
    MockPeerUser, MockPeerChannel, MockPeerChat,
    MockMessageMediaPhoto, MockMessageMediaDocument, MockReplyInlineMarkup,
    MockTelegramClient, mockClientInstance,
    mockAddEventHandler, mockGetDialogs, mockGetMessages, mockSendMessage, mockInvoke,
  };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {
    User:                MockUser,
    Chat:                MockChat,
    Channel:             MockChannel,
    PeerUser:            MockPeerUser,
    PeerChannel:         MockPeerChannel,
    PeerChat:            MockPeerChat,
    MessageMediaPhoto:   MockMessageMediaPhoto,
    MessageMediaDocument: MockMessageMediaDocument,
    ReplyInlineMarkup:   MockReplyInlineMarkup,
    contacts: {
      GetContacts:    vi.fn().mockImplementation((d: any) => d),
      ImportContacts: vi.fn().mockImplementation((d: any) => d),
      Search:         vi.fn().mockImplementation((d: any) => d),
    },
    InputPhoneContact: vi.fn().mockImplementation((d: any) => d),
  },
  Logger: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/extensions/Logger', () => ({
  LogLevel: { NONE: 0 },
}));

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/events', () => ({
  NewMessage: vi.fn().mockReturnValue({}),
}));

vi.mock('../db/database', () => ({
  db: { prepare: vi.fn() },
}));

vi.mock('../jobs/runner', () => ({
  parseTgProxy: vi.fn().mockReturnValue(undefined),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import {
  entityToChatId,
  peerToChatId,
  getLiveClient,
  loadDialogs,
  getMessages,
  sendMessage,
  getContacts,
  addContact,
  searchPeers,
  subscribeToMessages,
} from '../tg/liveClient';
import { db } from '../db/database';

const DEFAULT_ACCOUNT = {
  api_id: 12345,
  api_hash: 'abc123',
  session_string: 'test-session',
  proxy_id: null,
  app_client_id: null,
};

function setupDb(row: Record<string, any> | null = DEFAULT_ACCOUNT) {
  vi.mocked(db.prepare).mockImplementation((sql: string) => ({
    get: vi.fn().mockReturnValue(sql.includes('tg_accounts') ? row : null),
  } as any));
}

// Helper to build a LiveEntry without going through getLiveClient
function makeEntry(cacheEntries: [string, any][] = []) {
  return {
    client:      mockClientInstance as any,
    entityCache: new Map<string, any>(cacheEntries),
    subscribers: new Set<any>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDb();
});

// ---- entityToChatId --------------------------------------------------------

describe('entityToChatId', () => {
  it('returns u-prefixed id for User', () => {
    expect(entityToChatId(new MockUser({ id: 42n }) as any)).toBe('u42');
  });

  it('returns c-prefixed id for Channel', () => {
    expect(entityToChatId(new MockChannel({ id: 99n }) as any)).toBe('c99');
  });

  it('returns g-prefixed id for Chat (group)', () => {
    expect(entityToChatId(new MockChat({ id: 7n }) as any)).toBe('g7');
  });
});

// ---- peerToChatId ----------------------------------------------------------

describe('peerToChatId', () => {
  it('returns u-prefixed id for PeerUser', () => {
    expect(peerToChatId(new MockPeerUser({ userId: 10n }) as any)).toBe('u10');
  });

  it('returns c-prefixed id for PeerChannel', () => {
    expect(peerToChatId(new MockPeerChannel({ channelId: 20n }) as any)).toBe('c20');
  });

  it('returns g-prefixed id for PeerChat', () => {
    expect(peerToChatId(new MockPeerChat({ chatId: 30n }) as any)).toBe('g30');
  });

  it('returns empty string for an unknown peer type', () => {
    expect(peerToChatId({} as any)).toBe('');
  });
});

// ---- getLiveClient ---------------------------------------------------------

// Each test uses a unique account ID (3xx range) to avoid hitting the
// module-level liveClients cache from a prior test.

describe('getLiveClient', () => {
  it('creates and connects a TelegramClient with DB credentials', async () => {
    await getLiveClient(300);

    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.connect).toHaveBeenCalledTimes(1);
    const args = vi.mocked(TelegramClient).mock.calls[0];
    expect(args[1]).toBe(12345);
    expect(args[2]).toBe('abc123');
  });

  it('returns the cached entry on a second call without creating a new client', async () => {
    const first  = await getLiveClient(301);
    const second = await getLiveClient(301);

    expect(first).toBe(second);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
  });

  it('throws when the account row is not found in the DB', async () => {
    setupDb(null);
    await expect(getLiveClient(302)).rejects.toThrow('Account not found or not authenticated');
  });

  it('throws when session_string is null', async () => {
    setupDb({ ...DEFAULT_ACCOUNT, session_string: null });
    await expect(getLiveClient(303)).rejects.toThrow('Account not found or not authenticated');
  });
});

// ---- loadDialogs -----------------------------------------------------------

describe('loadDialogs', () => {
  it('populates the entity cache for each dialog entity', async () => {
    const user = new MockUser({ id: 1n, firstName: 'Alice' });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Alice', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const entry = makeEntry();
    await loadDialogs(entry as any);

    expect(entry.entityCache.has('u1')).toBe(true);
  });

  it('returns type=user for a regular (non-bot) User', async () => {
    const user = new MockUser({ id: 2n, firstName: 'Bob', bot: false });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Bob', dialog: { unreadCount: 1 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0]).toMatchObject({ chatId: 'u2', type: 'user' });
  });

  it('returns type=bot for a bot User', async () => {
    const bot = new MockUser({ id: 3n, username: 'mybot', bot: true });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: bot, name: 'My Bot', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0].type).toBe('bot');
  });

  it('returns type=channel for a non-megagroup Channel', async () => {
    const ch = new MockChannel({ id: 4n, title: 'News', megagroup: false });
    mockGetDialogs.mockResolvedValueOnce([
      { entity: ch, name: 'News', dialog: { unreadCount: 0 }, message: undefined },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0]).toMatchObject({ chatId: 'c4', type: 'channel' });
  });

  it('includes lastMessage and unreadCount when present on the dialog', async () => {
    const user = new MockUser({ id: 5n, firstName: 'Eve' });
    mockGetDialogs.mockResolvedValueOnce([
      {
        entity:  user,
        name:    'Eve',
        dialog:  { unreadCount: 3 },
        message: { message: 'Hi!', date: 1700000000, out: false },
      },
    ]);

    const result = await loadDialogs(makeEntry() as any);

    expect(result[0].unreadCount).toBe(3);
    expect(result[0].lastMessage).toEqual({ text: 'Hi!', date: 1700000000, fromMe: false });
  });
});

// ---- getMessages -----------------------------------------------------------

describe('getMessages', () => {
  it('returns formatted message payloads from the entity in cache', async () => {
    const user  = new MockUser({ id: 10n });
    const entry = makeEntry([['u10', user]]);

    mockGetMessages.mockResolvedValueOnce([
      { id: 1, message: 'Hello', date: 1700000000, out: false, fromId: null, media: null, replyMarkup: null },
    ]);

    const result = await getMessages(entry as any, 'u10', 20, 0);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, text: 'Hello', date: 1700000000, fromMe: false });
  });

  it('sets fromMe=true when msg.out is truthy', async () => {
    const user  = new MockUser({ id: 11n });
    const entry = makeEntry([['u11', user]]);

    mockGetMessages.mockResolvedValueOnce([
      { id: 2, message: 'Sent', date: 1700000001, out: true, fromId: null, media: null, replyMarkup: null },
    ]);

    const [msg] = await getMessages(entry as any, 'u11', 20, 0);
    expect(msg.fromMe).toBe(true);
  });

  it('sets hasPhoto=true when media is MessageMediaPhoto', async () => {
    const user  = new MockUser({ id: 12n });
    const entry = makeEntry([['u12', user]]);

    mockGetMessages.mockResolvedValueOnce([
      { id: 3, message: '', date: 1700000002, out: false, fromId: null, media: new MockMessageMediaPhoto(), replyMarkup: null },
    ]);

    const [msg] = await getMessages(entry as any, 'u12', 20, 0);
    expect(msg.hasPhoto).toBe(true);
    expect(msg.hasDocument).toBe(false);
  });

  it('calls loadDialogs via ensureEntityCached when entity is not in cache', async () => {
    const user  = new MockUser({ id: 13n });
    const entry = makeEntry(); // empty cache

    mockGetDialogs.mockResolvedValueOnce([
      { entity: user, name: 'Test', dialog: { unreadCount: 0 }, message: undefined },
    ]);
    mockGetMessages.mockResolvedValueOnce([
      { id: 4, message: 'Hi', date: 1700000003, out: false, fromId: null, media: null, replyMarkup: null },
    ]);

    await getMessages(entry as any, 'u13', 20, 0);

    expect(mockGetDialogs).toHaveBeenCalledTimes(1);
  });
});

// ---- sendMessage -----------------------------------------------------------

describe('sendMessage', () => {
  it('calls client.sendMessage with the cached entity and returns id + date', async () => {
    const user  = new MockUser({ id: 20n });
    const entry = makeEntry([['u20', user]]);

    mockSendMessage.mockResolvedValueOnce({ id: 99, date: 1700000010 });

    const result = await sendMessage(entry as any, 'u20', 'Hey there');

    expect(mockSendMessage).toHaveBeenCalledWith(user, { message: 'Hey there' });
    expect(result).toEqual({ id: 99, date: 1700000010 });
  });

  it('throws when entity is not found even after a cache reload', async () => {
    const entry = makeEntry(); // empty cache
    mockGetDialogs.mockResolvedValueOnce([]); // dialogs return nothing

    await expect(sendMessage(entry as any, 'u999', 'Fail')).rejects.toThrow('Chat not found');
  });
});

// ---- getContacts -----------------------------------------------------------

describe('getContacts', () => {
  it('returns a formatted contact list', async () => {
    const user = new MockUser({ id: 50n, firstName: 'Sam', lastName: 'Smith', username: 'samsmith', phone: '+61400000001' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const result = await getContacts(makeEntry() as any);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chatId:    'u50',
      firstName: 'Sam',
      lastName:  'Smith',
      username:  'samsmith',
      phone:     '+61400000001',
    });
  });

  it('filters out deleted users', async () => {
    const deleted = new MockUser({ id: 51n, deleted: true });
    const active  = new MockUser({ id: 52n, firstName: 'Active' });
    mockInvoke.mockResolvedValueOnce({ users: [deleted, active] });

    const result = await getContacts(makeEntry() as any);

    expect(result).toHaveLength(1);
    expect(result[0].chatId).toBe('u52');
  });

  it('caches each contact entity', async () => {
    const user = new MockUser({ id: 53n, firstName: 'Cached' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const entry = makeEntry();
    await getContacts(entry as any);

    expect(entry.entityCache.has('u53')).toBe(true);
  });
});

// ---- addContact ------------------------------------------------------------

describe('addContact', () => {
  it('returns null when ImportContacts returns no users', async () => {
    mockInvoke.mockResolvedValueOnce({ users: [] });

    const result = await addContact(makeEntry() as any, '+61400000001', 'New');
    expect(result).toBeNull();
  });

  it('returns a formatted contact and caches the entity when user is found', async () => {
    const user = new MockUser({ id: 60n, firstName: 'New', lastName: 'Contact', username: null, phone: '+61400000001' });
    mockInvoke.mockResolvedValueOnce({ users: [user] });

    const entry  = makeEntry();
    const result = await addContact(entry as any, '+61400000001', 'New', 'Contact');

    expect(result).toMatchObject({ chatId: 'u60', firstName: 'New', lastName: 'Contact' });
    expect(entry.entityCache.has('u60')).toBe(true);
  });
});

// ---- searchPeers -----------------------------------------------------------

describe('searchPeers', () => {
  it('returns formatted results for matching users', async () => {
    const user = new MockUser({ id: 70n, firstName: 'Found', username: 'found', bot: false });
    mockInvoke.mockResolvedValueOnce({ users: [user], chats: [] });

    const result = await searchPeers(makeEntry() as any, 'found');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'u70', type: 'user' });
  });

  it('returns formatted results for matching channels', async () => {
    const channel = new MockChannel({ id: 71n, title: 'Tech News', megagroup: false });
    mockInvoke.mockResolvedValueOnce({ users: [], chats: [channel] });

    const result = await searchPeers(makeEntry() as any, 'tech');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 'c71', type: 'channel' });
  });
});

// ---- subscribeToMessages ---------------------------------------------------

describe('subscribeToMessages', () => {
  it('returns a noop when no live client is cached for the account', () => {
    const sub = vi.fn();
    const unsub = subscribeToMessages(9999, sub);

    unsub(); // must not throw
    expect(sub).not.toHaveBeenCalled();
  });

  it('delivers live messages to the subscriber and stops after unsubscribe', async () => {
    await getLiveClient(400);

    const sub   = vi.fn();
    const unsub = subscribeToMessages(400, sub);

    // Grab the event handler registered with addEventHandler
    const [eventCb] = mockAddEventHandler.mock.calls[0];

    const peerId  = new MockPeerUser({ userId: 402n });
    const fromPeer = new MockPeerUser({ userId: 401n });

    eventCb({
      message: {
        id:          10,
        message:     'Incoming!',
        date:        1700000020,
        out:         false,
        peerId,
        fromId:      fromPeer,
        media:       null,
        replyMarkup: null,
      },
    });

    expect(sub).toHaveBeenCalledTimes(1);
    const liveMsg = sub.mock.calls[0][0];
    expect(liveMsg.chatId).toBe('u402');
    expect(liveMsg.message.text).toBe('Incoming!');
    expect(liveMsg.message.fromId).toBe('u401');

    // After unsub, further events must not reach the subscriber
    unsub();
    eventCb({
      message: {
        id: 11, message: 'After unsub', date: 1700000021,
        out: false, peerId, fromId: null, media: null, replyMarkup: null,
      },
    });

    expect(sub).toHaveBeenCalledTimes(1);
  });
});
