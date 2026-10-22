let manifestPromise;

export function loadAkwfManifest() {
  if (!manifestPromise) {
    const url = new URL("/wavetables/manifest.json", window.location.href);
    manifestPromise = fetch(url, { cache: "force-cache" }).then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load the bundled AKWF index (${response.status}).`);
      }
      return response.json();
    });
  }
  return manifestPromise;
}

export async function registerBuiltInWavetables(registerWaveTable) {
  const manifest = await loadAkwfManifest();
  const frameLength = manifest.frameLength || 600;
  for (const bank of manifest.banks) {
    const urls = bank.files.map((file) =>
      new URL(file, window.location.href).href,
    );
    registerWaveTable(bank.id, urls, { frameLen: frameLength });
  }
  return manifest;
}
