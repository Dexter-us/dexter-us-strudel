export const BUILT_IN_WAVETABLES = [
  { id: "dx_saw", label: "Saw — bright, buzzy" },
  { id: "dx_square", label: "Square — hollow, reedy" },
  { id: "dx_triangle", label: "Triangle — soft, rounded" },
  { id: "dx_bright", label: "Bright — sharp harmonics" },
  { id: "dx_hollow", label: "Hollow — woody formants" },
  { id: "dx_glass", label: "Glass — bell-like" },
];

const frameLength = 2048;

export function registerBuiltInWavetables(registerWaveTable) {
  for (const { id } of BUILT_IN_WAVETABLES) {
    const url = new URL(`/wavetables/${id}.wav`, window.location.href).href;
    registerWaveTable(id, [url], { frameLen: frameLength });
  }
}
