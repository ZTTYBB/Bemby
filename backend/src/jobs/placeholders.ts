// Placeholder expansion, shared by everything that takes a template a user typed: a start
// command, a device name, a login email, an address to open, and the text a page step types
// into a field. Kept in a module of its own so the browser side can reach it without pulling
// in a Telegram client.

import { fillDataRefs } from "../db/dataStore";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;

function pick(chars: string, len: number): string {
  return Array.from(
    { length: len },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

// Ordinary given names and surnames, for the forms that ask for one. A random string of
// letters is fine for a username nobody reads, but a signup form that wants a name is often
// checked -- by the site, or by whoever reads the account list later.
const FIRST_NAMES = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
  "Thomas", "Charles", "Daniel", "Matthew", "Anthony", "Mark", "Paul", "Steven",
  "Andrew", "Joshua", "Kevin", "Brian", "George", "Edward", "Ryan", "Jacob",
  "Nathan", "Adam", "Peter", "Simon", "Oliver", "Henry", "Leo", "Lucas", "Ethan",
  "Noah", "Liam", "Owen", "Felix", "Victor", "Marcus", "Julian",
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan",
  "Jessica", "Sarah", "Karen", "Nancy", "Laura", "Emily", "Emma", "Olivia",
  "Sophia", "Grace", "Chloe", "Hannah", "Ava", "Mia", "Isla", "Ruby", "Alice",
  "Clara", "Nina", "Elena", "Maya", "Zoe", "Iris",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin", "Jackson", "Lee",
  "Perez", "Thompson", "White", "Harris", "Clark", "Lewis", "Walker", "Hall",
  "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams",
  "Nelson", "Carter", "Mitchell", "Turner", "Phillips", "Campbell", "Parker",
  "Evans", "Edwards", "Collins", "Stewart", "Morris", "Murphy", "Cook", "Bailey",
  "Bell", "Ward", "Cox", "Richardson", "Wood", "Watson", "Brooks", "Gray",
];

function randomOf(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Expands template placeholders before a value is used.
 * Syntax: {type} or {type:length}
 * Types: word (lowercase), WORD (uppercase), num (digits), alpha (mixed alnum), uuid,
 * randomFirstName, randomLastName (an ordinary given name / surname; no length to give)
 * An optional context map supplies named tokens (e.g. {name}) that take
 * precedence over the built-in random types.
 *
 * `{data.folder.key}` reads the data store, `{data.folder.key.field}` one field of a record,
 * and `{data.folder[me@example.com].field}` the same where the key holds a dot. Those are
 * resolved last, after the names and random tokens, so a reference may be built out of them
 * (`{data.example[{username}@example.com].password}`) -- and so a stored value that happens to
 * contain braces is used as it stands rather than expanded again.
 */
export function expandCommand(template: string, context?: Record<string, string>): string {
  const expanded = template.replace(/\{(\w+)(?::(\d+))?\}/g, (match, type: string, lenStr?: string) => {
    if (context && Object.prototype.hasOwnProperty.call(context, type)) {
      return context[type];
    }
    const len = lenStr ? parseInt(lenStr, 10) : 0;
    switch (type) {
      case "word":
        return pick(LOWER, len || 6);
      case "WORD":
        return pick(UPPER, len || 6);
      case "num":
        return pick(DIGITS, len || 6);
      case "alpha":
        return pick(ALNUM, len || 8);
      case "randomFirstName":
        return randomOf(FIRST_NAMES);
      case "randomLastName":
        return randomOf(LAST_NAMES);
      case "uuid": {
        // RFC 4122 v4
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
      }
      default:
        return match; // unknown placeholder -- leave as-is
    }
  });
  return fillDataRefs(expanded);
}
