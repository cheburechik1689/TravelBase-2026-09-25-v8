import { createFileRoute } from "@tanstack/react-router";
import { handleTravelApi } from "@/lib/travelbase/handlers";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleTravelApi(request, params._splat ?? ""),
      POST: async ({ request, params }) => handleTravelApi(request, params._splat ?? ""),
    },
  },
});
