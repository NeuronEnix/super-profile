import { describe, expect, it } from "vitest";
import { stripQuotedReply } from "../src/email/inbound";

describe("stripQuotedReply", () => {
  it("leaves a fresh email (no quote) untouched", () => {
    const body = "Hi team, I was charged twice for my order last week. Can you refund one?";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("strips the Gmail 'On <date> … wrote:' attribution that wraps across lines", () => {
    const body = [
      "That's great, thank you for sorting it out so quickly! I can see one of the",
      "charges has already been reversed. Really appreciate the fast help. Cheers,",
      "Kaushik",
      "",
      "On Fri, Jul 10, 2026 at 5:56 PM ban gera <",
      "ban-gera@notifications.hyugorix.com> wrote:",
      "",
      "> Hi Kaushik, thanks for reaching out. I can see the duplicate $49 charge",
      "> from last week and I've issued a refund for one of them.",
      ">",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe(
      [
        "That's great, thank you for sorting it out so quickly! I can see one of the",
        "charges has already been reversed. Really appreciate the fast help. Cheers,",
        "Kaushik",
      ].join("\n"),
    );
  });

  it("strips the mobile-style 'On <date>, <name>, <email> wrote:' attribution", () => {
    const body = [
      "Thanks a lot",
      "",
      "On Fri, 10 Jul 2026, 18:04 Kaushik R Bangera, <kaushikrb909@gmail.com>",
      "wrote:",
      "",
      "> Yes, rate you 5 star",
      ">",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Thanks a lot");
  });

  it("cuts at the first quote when a thread has several nested attributions", () => {
    const body = [
      "glad that its resolved",
      "",
      "On Fri, 10 Jul 2026, 18:03 ban gera, <ban-gera@notifications.hyugorix.com>",
      "wrote:",
      "",
      "> Thanks",
      ">",
      "> On Fri, 10 Jul 2026, 18:00 Kaushik wrote:",
      ">> earlier message",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("glad that its resolved");
  });

  it("strips an Outlook '-----Original Message-----' divider", () => {
    const body = ["Please see my answer below.", "", "-----Original Message-----", "From: someone"].join("\n");
    expect(stripQuotedReply(body)).toBe("Please see my answer below.");
  });

  it("strips a bare '>' quote block with no attribution line", () => {
    const body = ["Sounds good, thanks!", "", "> previous message text"].join("\n");
    expect(stripQuotedReply(body)).toBe("Sounds good, thanks!");
  });

  it("never returns empty — falls back to the original when the whole body is a quote", () => {
    const body = "> only quoted content here";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("returns empty string unchanged", () => {
    expect(stripQuotedReply("")).toBe("");
  });
});
