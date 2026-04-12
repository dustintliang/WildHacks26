/**
 * Normalize per-artery analysis payloads from the API or fixtures (e.g. rich
 * "new nii data" responses) into the shape expected by AnalysisPanel.
 *
 * - Accepts either `arteries` or `binary_segments` keys (caller passes the object).
 * - Strips heavy `data` voxel lists so React state stays small.
 * - Maps flat `stenosis_candidates` / `aneurysm_candidates` into `findings`.
 */

export function pickNarrativeSummary(data) {
  if (!data || typeof data !== 'object') return ''
  return (
    data.narrative_summary
    ?? data.gemini_report?.narrative_summary
    ?? ''
  )
}

export function normalizeSegmentMap(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [name, artery] of Object.entries(raw)) {
    if (!artery || typeof artery !== 'object') continue

    const {
      data: _voxels,
      stenosis_candidates,
      aneurysm_candidates,
      ...rest
    } = artery

    const findings =
      'findings' in artery && artery.findings && typeof artery.findings === 'object'
        ? {
            stenosis: artery.findings.stenosis ?? [],
            aneurysms: artery.findings.aneurysms ?? [],
            tortuosity: artery.findings.tortuosity ?? artery.tortuosity ?? null,
          }
        : {
            stenosis: stenosis_candidates ?? [],
            aneurysms: aneurysm_candidates ?? [],
            tortuosity: artery.tortuosity ?? null,
          }

    out[name] = {
      ...rest,
      findings,
    }
  }
  return out
}
