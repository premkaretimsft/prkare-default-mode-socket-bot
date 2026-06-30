// Real Teams invoke handling — builds the appropriate Bot Framework invoke-response BODY for a given
// invoke name, mirroring prem-test-me-bot's response shapes (compose-extension result,
// AdaptiveCardInvokeResponse, task module, signin, default/unknown). The socket bot returns these as
// the client-results reply frame's { status, body }, exactly as the HTTP bot returns
// { status, JSON(body) } — so APX's InvokeHelper.ProcessInvokeResponse sees the same shape on both
// transports. Representative content (sample cards) — the SHAPES are what matter for parity.

export interface InvokeReply {
  status: number;
  body?: unknown;
}

function sampleAdaptiveCard(): Record<string, unknown> {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: "prkare-default-mode-socket-bot", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: "invoke handled over the Default-mode socket", wrap: true },
    ],
  };
}

function adaptiveAttachment(): Record<string, unknown> {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: sampleAdaptiveCard(),
  };
}

function heroAttachment(title: string): Record<string, unknown> {
  const content = { title, text: "socket test bot result" };
  return {
    contentType: "application/vnd.microsoft.card.hero",
    content,
    preview: { contentType: "application/vnd.microsoft.card.hero", content },
  };
}

// AdaptiveCardInvokeResponse — { statusCode, type, value }
function adaptiveCardInvokeResponse(statusCode: number, value: Record<string, unknown>): Record<string, unknown> {
  return { statusCode, type: "application/vnd.microsoft.card.adaptive", value };
}

// Maps an invoke `name` to its { status, body }. Unknown names fall through to a benign default,
// matching prem-test-me-bot's onInvokeActivity default branch.
export function buildInvokeResponse(name: string | undefined, value: any): InvokeReply {
  const n = (name || "").toLowerCase();
  switch (n) {
    case "composeextension/query":
    case "composeextension/querylink":
    case "composeextension/anonymousquerylink":
      return {
        status: 200,
        body: { composeExtension: { type: "result", attachmentLayout: "list", attachments: [heroAttachment("Socket query result")] } },
      };

    case "composeextension/submitaction":
      return {
        status: 200,
        body: { composeExtension: { type: "result", attachmentLayout: "list", attachments: [adaptiveAttachment()] } },
      };

    case "composeextension/fetchtask":
    case "task/fetch":
      return {
        status: 200,
        body: { task: { type: "continue", value: { title: "Socket task module", height: 200, width: 400, card: adaptiveAttachment() } } },
      };

    case "task/submit":
      return { status: 200, body: { task: { type: "message", value: "Socket task submitted" } } };

    case "adaptivecard/action":
      return { status: 200, body: adaptiveCardInvokeResponse(200, sampleAdaptiveCard()) };

    case "signin/verifystate":
    case "signin/tokenexchange":
      return { status: 200, body: {} };

    // 200 with no body — Bot Framework's CreateInvokeResponse(200) / { status: 200 } pattern.
    case "message/submitaction":
    case "suggestedactions/submit":
    case "voteinvoke":
      return { status: 200 };

    default:
      return { status: 200, body: `Unknown invoke activity handled as default- ${name}` };
  }
}
