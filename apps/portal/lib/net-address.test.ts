import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedAddressReason } from "./net-address.ts";

test("public IPv4 addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.0.1"]) assert.equal(blockedAddressReason(ip), null, ip);
});

test("private, loopback and link-local IPv4 are blocked", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255"]) {
    assert.ok(blockedAddressReason(ip), ip);
  }
});

test("IPv6 loopback, link-local, unique-local and mapped private addresses are blocked", () => {
  for (const ip of ["::", "::1", "fe80::1", "fd00::1", "fc12::5", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe"]) {
    assert.ok(blockedAddressReason(ip), ip);
  }
});

test("public IPv6 and mapped public IPv4 pass", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(blockedAddressReason(ip), null, ip);
});

test("garbage is blocked", () => {
  for (const ip of ["", "example.com", "999.1.1.1", "1:2:3", "1::2::3"]) assert.ok(blockedAddressReason(ip), ip);
});
