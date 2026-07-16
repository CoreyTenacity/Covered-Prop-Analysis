import { jsonRouteResponse } from "@/lib/api/route-response";
import { getCoveredPickDetails } from "@/lib/knowledge/read-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ scoredPropId: string }> },
) {
  const { scoredPropId } = await context.params;
  const row = await getCoveredPickDetails(scoredPropId);

  if (!row) {
    return jsonRouteResponse("/api/knowledge/covered-picks/[scoredPropId]", { error: "Covered pick not found." }, {
      status: 404,
      cacheProfile: "public-live",
      rowsReturned: 0,
    });
  }

  return jsonRouteResponse("/api/knowledge/covered-picks/[scoredPropId]", { row }, {
    cacheProfile: "public-live",
    rowsReturned: 1,
  });
}
