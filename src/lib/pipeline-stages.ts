/** User-facing pipeline steps shown on the render-wait screen. */
export const PIPELINE_STAGES = [
  { id: "reading_repo", label: "Reading your repo" },
  { id: "discovering_tour", label: "Discovering your tour" },
  { id: "filming_site", label: "Filming your site" },
  { id: "rendering", label: "Rendering" },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];

/**
 * Map UI / worker stage strings to the current pipeline step.
 * Worker stages: queued | discovering_tour | filming_app | cutting_video | ready
 * Web stages before the job: reading
 *
 * No fake pre-baked storyboard — the agent discovers beats while filming.
 */
export function resolvePipelineStage(
  uiStage: string,
  workerStage?: string | null,
): PipelineStageId {
  if (uiStage === "reading") return "reading_repo";
  if (uiStage === "planning") return "discovering_tour";

  switch (workerStage) {
    case "cutting_video":
    case "rendering":
      return "rendering";
    case "discovering_tour":
      return "discovering_tour";
    case "filming_app":
    case "recording":
      return "filming_site";
    case "queued":
    default:
      return "discovering_tour";
  }
}
