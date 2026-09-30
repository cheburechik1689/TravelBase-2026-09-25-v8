import { createFileRoute } from "@tanstack/react-router";
import { TravelBaseApp } from "@/components/travelbase-app";

export const Route = createFileRoute("/")({
  component: TravelBaseApp,
});
