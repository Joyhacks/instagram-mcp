import type { McpServer } from "@modelcontextprotocol/server";
import { registerCheckTokenHealth } from "./check-token-health.js";
import { registerGetPublishingLimit } from "./get-publishing-limit.js";
import { registerListRecentPosts } from "./list-recent-posts.js";
import { registerPublishCarousel } from "./publish-carousel.js";
import { registerPublishSingle } from "./publish-single.js";
import { registerUploadMedia } from "./upload-media.js";

export function registerAllTools(server: McpServer): void {
  registerUploadMedia(server);
  registerPublishCarousel(server);
  registerPublishSingle(server);
  registerGetPublishingLimit(server);
  registerCheckTokenHealth(server);
  registerListRecentPosts(server);
}
