// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress, safeFetch } from "../../lib/safe-fetch.js";

test("isPrivateAddress — IPv4 ranges that must never be dialled", () => {
  for (const ip of [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.1.1.1",
    "169.254.169.254", // AWS/GCE/Azure metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "224.0.0.1", // multicast
    "255.255.255.255",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("isPrivateAddress — public IPv4 passes, including range boundaries", () => {
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255", // 10/8 minus one
    "11.0.0.0", // 10/8 plus one
    "172.15.255.255", // 172.16/12 minus one
    "172.32.0.0", // 172.16/12 plus one
    "100.63.255.255", // 100.64/10 minus one
    "100.128.0.0", // 100.64/10 plus one
    "169.253.255.255",
    "169.255.0.0",
    "223.255.255.255", // 224/4 minus one
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress — IPv6 aliases of private v4 space are refused", () => {
  for (const ip of [
    // Hex spellings of the same addresses as the dotted forms below: one
    // address, one verdict. These come from RFC 4291 §2.5.5 examples, not from
    // the shape of the regex that reads them.
    "::ffff:7f00:1", // ::ffff:127.0.0.1
    "0:0:0:0:0:ffff:7f00:1", // uncompressed
    "::ffff:a9fe:a9fe", // ::ffff:169.254.169.254
    "::ffff:c0a8:1", // ::ffff:192.168.0.1
    "64:ff9b::7f00:1", // NAT64 loopback, hex form
    "::",
    "::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::127.0.0.1", // IPv4-compatible loopback
    "fc00::1", // unique-local
    "fd12:3456::1",
    "fe80::1", // link-local
    "feb0::1",
    "ff02::1", // multicast
    "64:ff9b::7f00:1", // NAT64 wrapping loopback
    "FE80::1", // case-insensitive
    "fe80::1%eth0", // zone id
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("isPrivateAddress — public IPv6 passes", () => {
  for (const ip of [
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808", // the same address in hex
    "64:ff9b::8.8.8.8",
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress — anything that is not an IP literal is refused", () => {
  for (const s of ["", "localhost", "example.com", "127.0.0.1.", "0x7f.1", "not an ip"]) {
    assert.equal(isPrivateAddress(s), true, s);
  }
});

test("safeFetch refuses non-https schemes", async () => {
  await assert.rejects(safeFetch("http://example.com/.well-known/did.json"), /non-https/);
});

test("safeFetch refuses credentials embedded in the URL", async () => {
  await assert.rejects(safeFetch("https://user:pass@example.com/did.json"), /credentials/);
});

test("safeFetch refuses a literal private address without resolving anything", async () => {
  for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "[::1]"]) {
    await assert.rejects(safeFetch(`https://${host}/x`), /non-public/, host);
  }
});

test("safeFetch refuses a hostname that resolves into private space", async () => {
  // localhost resolves to 127.0.0.1 / ::1 on every platform we run on.
  await assert.rejects(safeFetch("https://localhost/x"), /non-public|DNS lookup/);
});
