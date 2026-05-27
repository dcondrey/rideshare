// @ts-check
/**
 * Email transport — Resend HTTP API (preferred) or hand-rolled SMTP.
 *
 * No npm dependencies. Resend is ~10 lines of fetch. SMTP is ~180 lines of
 * line-based protocol implementation that handles the common case (PLAIN/LOGIN
 * AUTH, STARTTLS, single-recipient text/html messages). Sufficient for
 * Postmark, SES, Mailgun, Gmail SMTP, etc.
 */

import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";

/**
 * @typedef {Object} EmailMessage
 * @property {string} to
 * @property {string} subject
 * @property {string} text     — plain text body
 * @property {string} [html]   — optional HTML body
 */

/**
 * Send an email using whichever transport is configured.
 * @param {EmailMessage} msg
 */
export async function sendEmail(msg) {
  if (config.resendApiKey) return sendViaResend(msg);
  if (config.smtp.host) return sendViaSmtp(msg);
  throw new Error(
    "No email transport configured. Set RESEND_API_KEY or SMTP_HOST.",
  );
}

// ── Resend HTTP ──────────────────────────────────────────────────────────────
async function sendViaResend(msg) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}

// ── Hand-rolled SMTP ─────────────────────────────────────────────────────────
/**
 * @param {EmailMessage} msg
 */
async function sendViaSmtp(msg) {
  const { host, port, user, pass, secure } = config.smtp;

  // Connect (implicit TLS or plain socket).
  /** @type {import("node:net").Socket} */
  let sock = secure
    ? tlsConnect({ host, port, servername: host })
    : createConnection({ host, port });

  const session = new SmtpSession(sock);
  await session.expect(220);

  await session.cmd(`EHLO ${safeHostname()}`);
  let { code, lines } = await session.expect(250);

  // STARTTLS upgrade if needed and supported.
  if (!secure && lines.some((l) => /STARTTLS/i.test(l))) {
    await session.cmd("STARTTLS");
    await session.expect(220);
    sock = await upgradeToTls(sock, host);
    session.sock = sock;
    session.bind();
    await session.cmd(`EHLO ${safeHostname()}`);
    ({ code, lines } = await session.expect(250));
  }

  // AUTH (PLAIN preferred, LOGIN fallback).
  if (user && pass) {
    const supportsPlain = lines.some((l) => /AUTH[\s\S]*PLAIN/i.test(l));
    const supportsLogin = lines.some((l) => /AUTH[\s\S]*LOGIN/i.test(l));
    if (supportsPlain) {
      const token = Buffer.from(`\0${user}\0${pass}`).toString("base64");
      await session.cmd(`AUTH PLAIN ${token}`);
      await session.expect(235);
    } else if (supportsLogin) {
      await session.cmd("AUTH LOGIN");
      await session.expect(334);
      await session.cmd(Buffer.from(user).toString("base64"));
      await session.expect(334);
      await session.cmd(Buffer.from(pass).toString("base64"));
      await session.expect(235);
    } else {
      throw new Error("SMTP server does not advertise AUTH PLAIN or LOGIN");
    }
  }

  const fromAddr = extractAddr(config.emailFrom);
  await session.cmd(`MAIL FROM:<${fromAddr}>`);
  await session.expect(250);
  await session.cmd(`RCPT TO:<${msg.to}>`);
  await session.expect([250, 251]);
  await session.cmd("DATA");
  await session.expect(354);

  const data = buildRfc5322(msg);
  await session.write(data);
  await session.write("\r\n.\r\n");
  await session.expect(250);

  await session.cmd("QUIT");
  sock.end();
}

/** @param {import("node:net").Socket} sock @param {string} host */
function upgradeToTls(sock, host) {
  return new Promise((resolve, reject) => {
    const tlsSock = tlsConnect({ socket: sock, servername: host }, () =>
      resolve(tlsSock),
    );
    tlsSock.once("error", reject);
  });
}

class SmtpSession {
  /** @param {import("node:net").Socket} sock */
  constructor(sock) {
    this.sock = sock;
    this.buffer = "";
    /** @type {Array<(line: string) => void>} */
    this.lineWaiters = [];
    this.bind();
  }
  bind() {
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const w = this.lineWaiters.shift();
        if (w) w(line);
      }
    });
    this.sock.on("error", (err) => {
      const w = this.lineWaiters.shift();
      if (w) w(`000 ERR ${err.message}`);
    });
  }
  /** @param {string} data */
  write(data) {
    return new Promise((resolve, reject) =>
      this.sock.write(data, (err) => (err ? reject(err) : resolve(undefined))),
    );
  }
  /** @param {string} cmd */
  async cmd(cmd) {
    await this.write(cmd + "\r\n");
  }
  /**
   * Read response lines until a terminating space is seen (vs a continuation
   * dash). Validate the SMTP code matches `expected`.
   * @param {number | number[]} expected
   * @returns {Promise<{ code: number, lines: string[] }>}
   */
  async expect(expected) {
    const lines = [];
    let code = 0;
    while (true) {
      const line = await new Promise((resolve) => this.lineWaiters.push(resolve));
      lines.push(line);
      code = parseInt(line.slice(0, 3), 10);
      const sep = line[3];
      if (sep === " " || sep === undefined) break;
      // sep === "-" → continuation
    }
    const expectedArr = Array.isArray(expected) ? expected : [expected];
    if (!expectedArr.includes(code)) {
      throw new Error(`SMTP unexpected response: ${lines.join(" / ")}`);
    }
    return { code, lines };
  }
}

function safeHostname() {
  try {
    return process.env.HOSTNAME || "localhost";
  } catch {
    return "localhost";
  }
}

/** Pull "x@y.z" out of "Name <x@y.z>" or return as-is. */
function extractAddr(s) {
  const m = s.match(/<([^>]+)>/);
  return m ? m[1] : s.trim();
}

/** @param {EmailMessage} msg */
function buildRfc5322(msg) {
  const boundary = `b_${randomUUID().replace(/-/g, "")}`;
  const date = new Date().toUTCString();
  const messageId = `<${randomUUID()}@${extractAddr(config.emailFrom).split("@")[1] || "localhost"}>`;
  const headers = [
    `From: ${config.emailFrom}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
  ];
  if (msg.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `\r\n--${boundary}\r\n` +
      `Content-Type: text/plain; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      dotStuff(msg.text) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: text/html; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      dotStuff(msg.html) +
      `\r\n--${boundary}--\r\n`;
    return headers.join("\r\n") + "\r\n" + body;
  }
  headers.push(`Content-Type: text/plain; charset="utf-8"`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  return headers.join("\r\n") + "\r\n\r\n" + dotStuff(msg.text);
}

/** RFC 5321 §4.5.2 — lines beginning with "." must be doubled. */
function dotStuff(body) {
  return body
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? "." + l : l))
    .join("\r\n");
}

/** Encode any non-ASCII subject lines as MIME encoded-word. */
function encodeHeader(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}
