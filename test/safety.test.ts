import { describe, expect, it } from "vitest";
import { ipRateKey } from "../src/crypto";
import { checkAgentName, checkBuildCode, checkPlainText } from "../src/text-safety";

const title = (value: unknown) => checkPlainText(value, "title", 3, 80);

describe("text written by agents", () => {
  it("accepts ordinary text and tidies whitespace", () => {
    expect(title("  A  tiny\n garden ")).toBe("A tiny garden");
    expect(title("Ratio 16:9, café, 日本語, 100% fun")).toBe("Ratio 16:9, café, 日本語, 100% fun");
  });

  it.each([
    ["zero-width space", "hello\u{200B}world"],
    ["right-to-left override", "hello\u{202E}world"],
    ["invisible tag characters", "hello\u{e0041}\u{e0042}world"],
    ["variation selector smuggling", "hello\u{e0101}world"],
    ["escape character", "hello\u001bworld"],
    ["private use", "hello\u{E000}world"],
    ["stacked marks", "he" + "\u{301}".repeat(6) + "llo"],
  ])("rejects %s", (_label, value) => {
    expect(() => title(value)).toThrow(/invisible|control|stacked/);
  });

  it.each([
    "see https://example.org/x",
    "visit www.example.org",
    "go to evil.com now",
    "fullwidth ｈｔｔｐ：／／example.org",
    "mail me at a@b.co",
    "javascript:alert(1)",
  ])("rejects links: %s", (value) => {
    expect(() => title(value)).toThrow(/links/);
  });

  it("enforces length in characters", () => {
    expect(() => title("ab")).toThrow(/at least/);
    expect(() => title("x".repeat(81))).toThrow(/at most/);
    expect(() => title(42)).toThrow(/string/);
  });
});

describe("agent names", () => {
  it("accepts handle-like names", () => {
    expect(checkAgentName("quiet-otter_7")).toBe("quiet-otter_7");
  });
  it.each(["ab", "has space", "-leading", "trailing-", "x".repeat(25), "naïve", "a.b.c"])("rejects %s", (name) => {
    expect(() => checkAgentName(name)).toThrow();
  });
  it.each(["System", "admin-bot", "Moderator_1", "official-news", "SECURITY-team"])("reserves %s", (name) => {
    expect(() => checkAgentName(name)).toThrow(/reserved/);
  });
});

describe("build code", () => {
  it("accepts a drawing program without warnings", () => {
    expect(checkBuildCode('const ctx = canvas.getContext("2d"); on("frame", () => ctx.fillRect(0, 0, 9, 9));').warnings).toEqual([]);
  });
  it("warns about things that will not work where builds run", () => {
    const warnings = (code: string) => checkBuildCode(code).warnings.join(" ");
    expect(warnings("<!doctype html><canvas></canvas><script>1</script>")).toMatch(/looks like HTML/);
    expect(warnings('document.body.append("x"); canvas.getContext("2d");')).toMatch(/no document/);
    expect(warnings('fetch("/x"); canvas.getContext("2d");')).toMatch(/network calls/);
    expect(warnings('eval("1"); canvas.getContext("2d");')).toMatch(/eval/);
    expect(warnings("let total = 0; for (let i = 0; i < 10; i++) total += i;")).toMatch(/draw nothing/);
  });
  it("rejects oversized, tiny and malformed input", () => {
    expect(() => checkBuildCode("x".repeat(200_001))).toThrow(/limit/);
    expect(() => checkBuildCode("hi")).toThrow(/short/);
    expect(() => checkBuildCode("const broken = '\ud800 surrogate here';")).toThrow(/invalid/);
    expect(() => checkBuildCode("const nul = '\u0000 byte inside here';")).toThrow(/invalid/);
    expect(() => checkBuildCode({ code: "x" })).toThrow(/string/);
  });
});

describe("rate-limit address grouping", () => {
  it("keeps IPv4 addresses separate and groups IPv6 by the /56 one customer is given", () => {
    expect(ipRateKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipRateKey("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
    expect(ipRateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(ipRateKey("2001:0db8:0001:0002::1"));
    // Every /64 inside one /56 is the same customer.
    expect(ipRateKey("2001:db8:1:200::1")).toBe(ipRateKey("2001:db8:1:2ff:9::1"));
    expect(ipRateKey("2001:db8:1:200::1")).not.toBe(ipRateKey("2001:db8:1:300::1"));
    expect(ipRateKey("2001:db8::1")).toBe("20010db8000000/56");
    // The wider grouping takes in a whole /48.
    expect(ipRateKey("2001:db8:1:200::1", 48)).toBe(ipRateKey("2001:db8:1:ff00::1", 48));
    expect(ipRateKey("2001:db8:1::1", 48)).not.toBe(ipRateKey("2001:db8:2::1", 48));
    expect(ipRateKey("203.0.113.7", 48)).toBe("203.0.113.7");
  });
});
