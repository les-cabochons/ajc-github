import { afterEach, describe, expect, it, vi } from "vitest";
import { readDescription, syncConnection, writeDescription } from "../src/plugin.ts";

const ISSUE_URL = "https://github.com/acme/api/issues/7";
const REST_ISSUE = "https://api.github.com/repos/acme/api/issues/7";

const connection = {
  id: "connection-1",
  pluginId: "github",
  label: "Work",
  tenantLabel: "Acme",
  autoSync: true,
  autoSyncIntervalMinutes: 5,
  connectedAt: 1,
  config: { hostUrl: "https://github.com", token: "secret" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** An issue as GitHub's GraphQL search returns it. */
function graphqlIssue(body: string) {
  return {
    id: "I_7",
    number: 7,
    url: ISSUE_URL,
    title: "Rate limits",
    body,
    state: "OPEN",
    stateReason: null,
    repository: { nameWithOwner: "acme/api" },
    assignees: { nodes: [{ login: "octocat" }] },
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * GitHub with one issue, routed by method and URL: GraphQL search for a sync,
 * REST for reading and updating the issue.
 */
function stubGitHub(body: string, options: { pullRequest?: boolean; patchStatus?: number } = {}) {
  const issue: Record<string, unknown> = {
    number: 7,
    html_url: options.pullRequest ? "https://github.com/acme/api/pull/7" : ISSUE_URL,
    body,
    ...(options.pullRequest ? { pull_request: { url: "https://api.github.com/repos/acme/api/pulls/7" } } : {}),
  };
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url: String(input),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      calls.push(call);
      if (call.url === "https://api.github.com/graphql") {
        return json({
          data: {
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphqlIssue(issue.body as string)],
            },
          },
        });
      }
      if (call.url === REST_ISSUE && call.method === "GET") {
        return json(issue);
      }
      if (call.url === REST_ISSUE && call.method === "PATCH") {
        if (options.patchStatus) {
          return json({ message: "Resource not accessible by personal access token" }, options.patchStatus);
        }
        issue.body = call.body?.body;
        return json(issue);
      }
      return json({ message: "Not Found" }, 404);
    }),
  );
  return {
    calls,
    issue,
    patches: () => calls.filter((call) => call.method === "PATCH"),
  };
}

async function syncedDescription(body: string) {
  stubGitHub(body);
  const result = await syncConnection(connection, []);
  return result.items[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("descriptions a sync sends", () => {
  it("sends the body as written, mentions and GitHub-only syntax included, beside the old note", async () => {
    const body = [
      "Steps for @octocat and @acme/backend:",
      "",
      "- [ ] Reproduce",
      "- [x] Write a test",
      "",
      "> [!NOTE]",
      "> Rate limits apply per token.",
      "",
      "<details><summary>Logs</summary>",
      "",
      "```",
      "429 Too Many Requests",
      "```",
      "</details>",
    ].join("\n");

    const candidate = await syncedDescription(body);

    expect(candidate.description).toEqual({ text: body });
    expect(candidate.note).toBe(body);
  });

  it("gives Ajour Unix line endings, without the blank lines and spaces around the text", async () => {
    const candidate = await syncedDescription("\r\n\r\n  Indented first line\r\nSecond line  \r\n\r\n");

    expect(candidate.description).toEqual({ text: "  Indented first line\nSecond line" });
  });

  it("names mixed line endings as lost, since a write would make them one kind", async () => {
    const candidate = await syncedDescription("First\r\nSecond\nThird");

    expect(candidate.description).toEqual({
      text: "First\nSecond\nThird",
      lost: ["line endings Ajour cannot keep"],
    });
  });

  it("cuts a body longer than Ajour stores at 64,000 characters, never inside a character", async () => {
    const candidate = await syncedDescription(`${"a".repeat(63_999)}😀 and more`);

    expect(candidate.description).toEqual({ text: "a".repeat(63_999), cut: true });
    expect(candidate.note).toHaveLength(4000);
  });

  it("sends an empty description for an issue without a body", async () => {
    const candidate = await syncedDescription("");

    expect(candidate.description).toEqual({ text: "" });
    expect(candidate.note).toBeUndefined();
  });
});

describe("readDescription", () => {
  it("returns the issue's current body as a sync sends it", async () => {
    const { calls } = stubGitHub("Now with @octocat\r\n");

    await expect(readDescription(connection, { sourceId: ISSUE_URL })).resolves.toEqual({
      description: { text: "Now with @octocat" },
    });
    expect(calls).toEqual([{ method: "GET", url: REST_ISSUE }]);
  });

  it("refuses a pull request, which is not a backlog item", async () => {
    stubGitHub("A pull request body", { pullRequest: true });

    await expect(readDescription(connection, { sourceId: ISSUE_URL })).rejects.toThrow(/pull request/);
  });

  it("refuses an item of another GitHub instance without calling it", async () => {
    const { calls } = stubGitHub("Body");

    await expect(
      readDescription(connection, { sourceId: "https://github.acme.com/acme/api/issues/7" }),
    ).rejects.toThrow(/not an issue/);
    expect(calls).toEqual([]);
  });
});

describe("writeDescription", () => {
  it("writes the text as it is, reading the issue just before", async () => {
    const { calls, issue } = stubGitHub("Steps\n\n- [ ] Reproduce");

    await expect(
      writeDescription(connection, {
        sourceId: ISSUE_URL,
        text: "Steps for @octocat\n\n- [x] Reproduce",
        expected: "Steps\n\n- [ ] Reproduce",
      }),
    ).resolves.toEqual({ outcome: "written", description: { text: "Steps for @octocat\n\n- [x] Reproduce" } });
    expect(calls).toEqual([
      { method: "GET", url: REST_ISSUE },
      { method: "PATCH", url: REST_ISSUE, body: { body: "Steps for @octocat\n\n- [x] Reproduce" } },
    ]);
    expect(issue.body).toBe("Steps for @octocat\n\n- [x] Reproduce");
  });

  it("keeps the body's line endings and the blank lines around it", async () => {
    const { patches } = stubGitHub("\r\nFirst\r\nSecond\r\n\r\n");

    await writeDescription(connection, { sourceId: ISSUE_URL, text: "First\nChanged", expected: "First\nSecond" });

    expect(patches()[0]?.body).toEqual({ body: "\r\nFirst\r\nChanged\r\n\r\n" });
  });

  describe("keeps the whitespace Ajour's copy trims where it was", () => {
    /** The body written for `text`, over an issue whose body is `source`. */
    async function written(source: string, text: string) {
      const { patches } = stubGitHub(source);
      const read = await readDescription(connection, { sourceId: ISSUE_URL });
      await writeDescription(connection, { sourceId: ISSUE_URL, text, expected: read.description.text });
      return patches()[0]?.body?.body;
    }

    it("keeps trailing spaces on their line when the user appends after it", async () => {
      await expect(written("First\nKeep  \n", "First\nKeep\nNext")).resolves.toBe("First\nKeep  \nNext\n");
    });

    it("keeps a trailing non-breaking space and tab on their line when the user appends after it", async () => {
      await expect(written("First\nKeep \t", "First\nKeep\nNext")).resolves.toBe("First\nKeep \t\nNext");
    });

    it("keeps them with Windows line endings", async () => {
      await expect(written("First\r\nKeep  \r\n", "First\nKeep\nNext")).resolves.toBe(
        "First\r\nKeep  \r\nNext\r\n",
      );
    });

    it("keeps leading blank lines at the start when the user prepends a line", async () => {
      await expect(written("\n \nFirst\nLast", "Intro\nFirst\nLast")).resolves.toBe("\n \nIntro\nFirst\nLast");
    });

    it("keeps trailing blank lines at the end when the user appends a line", async () => {
      await expect(written("First\n\n \n", "First\nNext")).resolves.toBe("First\nNext\n\n \n");
    });

    it("keeps the last line's trailing spaces when the user edits only earlier lines", async () => {
      await expect(written("First\nKeep \t\n", "Changed\nKeep")).resolves.toBe("Changed\nKeep \t\n");
    });

    it("finds the last line between lines the user added before and after it", async () => {
      await expect(written("A\nKeep  ", "X\nA\nKeep\nY")).resolves.toBe("X\nA\nKeep  \nY");
    });

    it("writes the last line as the user typed it when they edit it, keeping the blank lines after it", async () => {
      await expect(written("First\nKeep  \n\n", "First\nKept")).resolves.toBe("First\nKept\n\n");
    });

    it("drops the trailing spaces with the last line when the user deletes it", async () => {
      await expect(written("First\nKeep  \n", "First")).resolves.toBe("First\n");
    });

    it("replaces a blank body whole, and empties the body when the user empties the text", async () => {
      await expect(written(" \n\n", "Hello")).resolves.toBe("Hello");
      await expect(written("\nFirst  \n", "")).resolves.toBe("");
    });
  });

  it("answers a conflict and writes nothing when the issue changed since Ajour read it", async () => {
    const { patches } = stubGitHub("Edited by a colleague");

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "Original" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Edited by a colleague" } });
    expect(patches()).toEqual([]);
  });

  it("refuses text over GitHub's 65,536 characters once written, and writes nothing", async () => {
    const { patches } = stubGitHub("a\r\nb");
    const text = "line\n".repeat(12_000).trimEnd();

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text, expected: "a\nb" }),
    ).rejects.toThrow("This description is too long for GitHub: 71,998 of 65,536 characters.");
    expect(patches()).toEqual([]);
  });

  it("counts characters as GitHub does, so a character made of two code units counts once", async () => {
    const { patches } = stubGitHub("");
    const text = "😀".repeat(32_000);

    await writeDescription(connection, { sourceId: ISSUE_URL, text, expected: "" });

    expect(patches()).toHaveLength(1);
  });

  it("refuses a cut description, and mixed line endings unless the user allowed that loss", async () => {
    stubGitHub(`${"a".repeat(64_001)}`);
    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Short", expected: "a".repeat(64_000) }),
    ).rejects.toThrow(/longer than Ajour keeps/);

    const mixed = stubGitHub("First\r\nSecond\nThird");
    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "First", expected: "First\nSecond\nThird" }),
    ).rejects.toThrow(/line endings Ajour cannot keep/);
    expect(mixed.patches()).toEqual([]);

    await writeDescription(connection, {
      sourceId: ISSUE_URL,
      text: "First",
      expected: "First\nSecond\nThird",
      allowedLoss: ["line endings Ajour cannot keep"],
    });
    expect(mixed.patches()[0]?.body).toEqual({ body: "First" });
  });

  it("never writes a pull request's body", async () => {
    const { patches } = stubGitHub("A pull request body", { pullRequest: true });

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "A pull request body" }),
    ).rejects.toThrow(/pull request/);
    expect(patches()).toEqual([]);
  });

  it("names the permission when GitHub refuses the write", async () => {
    stubGitHub("Body", { patchStatus: 403 });

    await expect(
      writeDescription(connection, { sourceId: ISSUE_URL, text: "Mine", expected: "Body" }),
    ).rejects.toThrow(
      "GitHub request failed (403): Resource not accessible by personal access token. Writing a description needs the token's Issues permission set to Read and write.",
    );
  });
});
