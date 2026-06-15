import { TelegramClient, Api, Logger } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import {
  expandCommand,
  selectButtonWithAI,
  parseMessages,
  waitForBotMessageEdit,
  waitForNewBotMessage,
  isAiBtn,
  parseAiBtnHint,
} from './checkin';
import type { CustomConfig, CustomStepLog } from '../types';

export type CustomJobLog = {
  steps: CustomStepLog[];
};

// Collects messages from the target until one has buttons or timeout fires.
// Resolves with whatever was collected (may be empty on timeout).
function waitForReply(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Job cancelled')); return; }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      if (collected.length > 0) resolve(collected);
      else reject(new Error(`No reply received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if ((msg as any).replyMarkup) { cleanup(); resolve(collected); }
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [fromUsername] }));
  });
}

// Waits specifically for a message with buttons from the target.
function waitForButtonsMessage(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Job cancelled')); return; }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No message with buttons received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if ((msg as any).replyMarkup) { cleanup(); resolve(collected); }
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [fromUsername] }));
  });
}

export async function runCustom(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  config: CustomConfig,
  signal?: AbortSignal,
): Promise<CustomJobLog> {
  const log: CustomJobLog = { steps: [] };

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
  });

  await client.connect();

  // State shared across actions in this session
  let lastMessages: Api.Message[] = [];
  let lastButtonsMsg: Api.Message | null = null;

  try {
    for (let i = 0; i < config.actions.length; i++) {
      if (signal?.aborted) throw new Error('Job cancelled');

      const action = config.actions[i];
      const step: CustomStepLog = { step: i + 1, actionType: action.type, label: '' };
      log.steps.push(step);
      const t0 = Date.now();

      try {
        switch (action.type) {

          case 'send_command': {
            const expanded = expandCommand(action.content);
            step.label = `Send: "${expanded}"`;
            await client.sendMessage(botUsername, { message: expanded });
            // Clear previous reply state -- new command starts a fresh exchange
            lastMessages = [];
            lastButtonsMsg = null;
            step.result = 'Sent';
            break;
          }

          case 'wait_reply': {
            step.label = `Wait reply (max ${action.maxWaitMs}ms)`;
            const msgs = await waitForReply(client, botUsername, action.maxWaitMs, signal);
            lastMessages = msgs;
            step.msgCount = msgs.length;
            const btnMsg = [...msgs].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup) ?? null;
            if (btnMsg) lastButtonsMsg = btnMsg;
            const parsed = await parseMessages(msgs, client, signal);
            step.responseHtml = parsed.html || undefined;
            step.responseImage = parsed.images[0];
            step.responseHasMedia = parsed.hasMedia || undefined;
            step.responseButtons = parsed.buttons.length ? parsed.buttons : undefined;
            step.result = `Received ${msgs.length} message(s)`;
            break;
          }

          case 'delay': {
            step.label = `Delay ${action.waitMs}ms`;
            await new Promise<void>((res, rej) => {
              if (signal?.aborted) { rej(new Error('Job cancelled')); return; }
              const timer = setTimeout(res, action.waitMs);
              signal?.addEventListener('abort', () => { clearTimeout(timer); rej(new Error('Job cancelled')); }, { once: true });
            });
            step.result = 'Done';
            break;
          }

          case 'click_button': {
            step.label = `Click button "${action.button}"`;

            // Use cached buttons message or wait for one
            let buttonsMsg: Api.Message | null = lastButtonsMsg;
            let preClickImages: string[] = [];
            if (!buttonsMsg) {
              const msgs = await waitForButtonsMessage(client, botUsername, action.maxWaitMs, signal);
              lastMessages = msgs;
              buttonsMsg = [...msgs].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup) ?? null;
              if (buttonsMsg) lastButtonsMsg = buttonsMsg;
              // Log the bot messages we received while waiting (reply to prior send_command)
              const preParsed = await parseMessages(msgs, client, signal);
              if (preParsed.html) step.preClickHtml = preParsed.html;
              if (preParsed.images.length) { step.preClickImage = preParsed.images[0]; preClickImages = preParsed.images; }
              if (preParsed.hasMedia) step.preClickHasMedia = preParsed.hasMedia;
              if (preParsed.buttons.length) step.preClickButtons = preParsed.buttons;
            }
            if (!buttonsMsg) throw new Error('No message with buttons available');

            const btnMarkup = (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup;
            const allBtnRows = btnMarkup.rows;
            const flat = allBtnRows.flatMap(row => row.buttons.map((b: any) => b.text as string));

            let targetText: string;
            let useExactMatch: boolean;

            if (action.button === '{anyBtn}') {
              if (!flat.length) throw new Error('No buttons available for {anyBtn}');
              targetText = flat[Math.floor(Math.random() * flat.length)];
              useExactMatch = true;
            } else if (isAiBtn(action.button)) {
              const buttons: string[][] = allBtnRows.map(row => row.buttons.map((b: any) => b.text as string));
              const hint = parseAiBtnHint(action.button);
              // If buttonsMsg was cached (no fresh parse), parse it now so we have HTML + images for AI
              if (!step.preClickHtml && !preClickImages.length) {
                const parsed = await parseMessages([buttonsMsg], client, signal);
                if (parsed.html) step.preClickHtml = parsed.html;
                if (parsed.images.length) { step.preClickImage = parsed.images[0]; preClickImages = parsed.images; }
                if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
                if (parsed.buttons.length) step.preClickButtons = parsed.buttons;
              }
              const aiStart = Date.now();
              const aiResult = await selectButtonWithAI(buttons, step.preClickHtml ?? buttonsMsg.message ?? '', preClickImages, hint);
              targetText = aiResult.button;
              step.aiDurationMs = Date.now() - aiStart;
              step.aiPrompt = aiResult.prompt;
              step.aiResponse = aiResult.response;
              useExactMatch = true;
            } else {
              targetText = action.button;
              useExactMatch = false;
            }

            const peer = await client.getInputEntity(botUsername);
            let clicked = false;
            let retryCount = 0;

            for (let attempt = 0; attempt <= action.maxRetries && !clicked; attempt++) {
              if (attempt > 0) {
                retryCount = attempt;
                // Wait for a new buttons message on retry
                const msgs = await waitForButtonsMessage(client, botUsername, action.maxWaitMs, signal).catch(() => null);
                if (msgs) {
                  lastMessages = msgs;
                  const bm = [...msgs].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup);
                  if (bm) { buttonsMsg = bm; lastButtonsMsg = bm; }
                }
              }

              const rows = ((buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup).rows;
              for (const row of rows) {
                for (const btn of row.buttons) {
                  const btnText = (btn as any).text as string;
                  const matches = useExactMatch ? btnText === targetText : btnText.includes(targetText);
                  if (!matches) continue;

                  const editPromise = waitForBotMessageEdit(client, buttonsMsg!.id, 10_000, signal);
                  const newMsgPromise = waitForNewBotMessage(client, botUsername, 10_000, signal);

                  const callbackData = (btn as Api.KeyboardButtonCallback).data;
                  const answer = await client.invoke(new Api.messages.GetBotCallbackAnswer({
                    peer,
                    msgId: buttonsMsg!.id,
                    data: callbackData,
                  })) as Api.messages.BotCallbackAnswer;

                  if (answer.message) step.callbackAnswer = answer.message;
                  clicked = true;
                  step.retryCount = retryCount;

                  const taggedEdit = editPromise.then(m => ({ msg: m, src: 'edit' as const }));
                  const taggedNew = newMsgPromise.then(m => ({ msg: m, src: 'new_message' as const }));
                  const { msg: responseMsg, src: respSrc } = await Promise.race([taggedEdit, taggedNew]);
                  if (responseMsg && !signal?.aborted) {
                    step.responseSource = respSrc;
                    lastMessages = [responseMsg];
                    if ((responseMsg as any).replyMarkup instanceof Api.ReplyInlineMarkup) lastButtonsMsg = responseMsg;
                    const parsed = await parseMessages([responseMsg], client, signal);
                    step.responseHtml = parsed.html || undefined;
                    step.responseImage = parsed.images[0];
                    step.responseHasMedia = parsed.hasMedia || undefined;
                    step.responseButtons = parsed.buttons.length ? parsed.buttons : undefined;
                  }

                  step.clickedButton = btnText;
                  step.result = `Clicked "${btnText}"`;
                  break;
                }
                if (clicked) break;
              }
            }

            if (!clicked) throw new Error(`Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`);
            break;
          }
        }
      } catch (err: any) {
        step.error = err?.message ?? String(err);
        step.errorName = err?.name ?? err?.constructor?.name;
        throw err;
      } finally {
        step.durationMs = Date.now() - t0;
      }
    }
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }

  return log;
}
