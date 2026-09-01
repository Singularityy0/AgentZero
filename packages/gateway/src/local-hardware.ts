import { totalmem } from "node:os";

/**
 * The problem statement caps local models at a machine with 16 GB RAM and 8 GB
 * VRAM. Node cannot read VRAM portably without a native dependency, so the
 * check works from the quantity that actually decides whether a model loads:
 * the size of its weights on disk, which Ollama reports for every installed
 * model. A model whose weights exceed the VRAM budget is not blocked — it will
 * run, spilling into system RAM and slowing down — but it is reported, so the
 * choice is visible rather than silent.
 */
export const LOCAL_RAM_BUDGET_BYTES = 16 * 1024 ** 3;
export const LOCAL_VRAM_BUDGET_BYTES = 8 * 1024 ** 3;

/** Headroom for the runtime, the IDE, and the OS alongside the weights. */
const RUNTIME_OVERHEAD_BYTES = 2 * 1024 ** 3;

export type LocalFitVerdict = "fits" | "tight" | "exceeds" | "unknown";

export interface LocalHardwareAssessment {
  verdict: LocalFitVerdict;
  /** Weight size in bytes, when the provider reported one. */
  modelBytes?: number;
  /** Physical RAM on this machine. */
  hostRamBytes: number;
  /** Budgets the assessment was made against. */
  vramBudgetBytes: number;
  ramBudgetBytes: number;
  detail: string;
}

/**
 * Judges whether a local model is a reasonable fit for the reference machine.
 *
 * `fits`    — weights sit inside the VRAM budget.
 * `tight`   — weights exceed VRAM but fit RAM with overhead; it will run slowly.
 * `exceeds` — weights do not fit the reference machine at all.
 * `unknown` — the provider reported no size; nothing is claimed.
 */
export function assessLocalModel(
  modelBytes: number | undefined,
  hostRamBytes: number = totalmem(),
): LocalHardwareAssessment {
  const base = {
    hostRamBytes,
    vramBudgetBytes: LOCAL_VRAM_BUDGET_BYTES,
    ramBudgetBytes: LOCAL_RAM_BUDGET_BYTES,
  };
  if (!modelBytes || modelBytes <= 0) {
    return {
      ...base,
      verdict: "unknown",
      detail:
        "The provider reported no weight size, so the fit against 16 GB RAM / 8 GB VRAM could not be verified.",
    };
  }
  const usable = LOCAL_RAM_BUDGET_BYTES - RUNTIME_OVERHEAD_BYTES;
  if (modelBytes <= LOCAL_VRAM_BUDGET_BYTES) {
    return {
      ...base,
      modelBytes,
      verdict: "fits",
      detail: `${formatGiB(modelBytes)} of weights fits the 8 GB VRAM budget.`,
    };
  }
  if (modelBytes <= usable) {
    return {
      ...base,
      modelBytes,
      verdict: "tight",
      detail:
        `${formatGiB(modelBytes)} of weights exceeds the 8 GB VRAM budget but fits 16 GB RAM. ` +
        "It will run with CPU offload and be noticeably slower.",
    };
  }
  return {
    ...base,
    modelBytes,
    verdict: "exceeds",
    detail:
      `${formatGiB(modelBytes)} of weights does not fit the 16 GB RAM / 8 GB VRAM reference machine ` +
      `(${formatGiB(usable)} usable after runtime overhead).`,
  };
}

export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
