/** Post-production presets shared by server and client code (no Node imports here). */
export const MASTER_PRESETS = ["clear", "warm", "loud", "off"] as const;
export type MasterPreset = (typeof MASTER_PRESETS)[number];

export const MASTER_LABELS: Record<MasterPreset, string> = {
  clear: "Claro (recomendado)",
  warm: "Cálido",
  loud: "Fuerte",
  off: "Sin procesar",
};
