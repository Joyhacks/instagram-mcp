import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyBearerToken } from "../src/auth.js";
import { registerAllTools } from "../src/tools/index.js";

/**
 * The MCP endpoint. Streamable HTTP via Vercel's mcp-handler v2 (no SSE
 * transport — removed upstream in 2.x, which matches this project's
 * requirements exactly).
 *
 * Auth: withMcpAuth with required:true means every request must carry
 * "Authorization: Bearer <token>". Unknown or droked tokens get a 401 before
 * any tool logic runs. The verified member rides on the request's AuthInfo and
 * is the ONLY way tools learn which Instagram account to touch.
 */
const baseHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    serverInfo: { name: "instagram-publisher", version: "1.0.0" },
    instructions:
      "Publishes Instagram carousels and single images for the authenticated team member. " +
      "Each bearer token maps to exactly one Instagram account; there is no way to select " +
      "an account per call. Typical flow: upload_media for each slide, then publish_carousel " +
      "(or publish_single), then list_recent_posts to confirm.",
  },
);

const handler = withMcpAuth(baseHandler, verifyBearerToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
