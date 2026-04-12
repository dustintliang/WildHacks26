import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Niivue, cmapper } from '@niivue/niivue'

// ─── View / UI constants ───────────────────────────────────────────────────────
const SLICE_VIEWS = [
  { label: 'Axial',     value: 0 },
  { label: 'Coronal',   value: 1 },
  { label: 'Sagittal',  value: 2 },
  { label: 'Multi',     value: 3 },
  { label: '3D',        value: 4 },
]

// ─── Artery metadata ──────────────────────────────────────────────────────────
// Label IDs 1–11 (0 = background).  Order MUST match backend step6_render.
export const ARTERY_META = [
  { id: 1,  key: 'left_ICA',        name: 'L-ICA',    rgb: [51,  153, 255] },
  { id: 2,  key: 'right_ICA',       name: 'R-ICA',    rgb: [0,   102, 204] },
  { id: 3,  key: 'left_MCA',        name: 'L-MCA',    rgb: [0,   204, 102] },
  { id: 4,  key: 'right_MCA',       name: 'R-MCA',    rgb: [0,   153,  51] },
  { id: 5,  key: 'left_ACA',        name: 'L-ACA',    rgb: [255, 204,   0] },
  { id: 6,  key: 'right_ACA',       name: 'R-ACA',    rgb: [204, 153,   0] },
  { id: 7,  key: 'left_PCA',        name: 'L-PCA',    rgb: [204,  51, 204] },
  { id: 8,  key: 'right_PCA',       name: 'R-PCA',    rgb: [153,   0, 153] },
  { id: 9,  key: 'basilar',         name: 'Basilar',  rgb: [255, 128,   0] },
  { id: 10, key: 'left_vertebral',  name: 'L-Vert',   rgb: [102, 204, 204] },
  { id: 11, key: 'right_vertebral', name: 'R-Vert',   rgb: [51,  153, 153] },
]

function rgbStr([r, g, b]) { return `rgb(${r},${g},${b})` }

// Build a NiiVue label-LUT from ARTERY_META
function buildArteryLabelLut() {
  const R = [0], G = [0], B = [0], labels = ['']
  ARTERY_META.forEach(({ rgb: [r, g, b], name }) => {
    R.push(r); G.push(g); B.push(b); labels.push(name)
  })
  return cmapper.makeLabelLut({ R, G, B, labels })
}

const OVERLAY_LABEL  = 'artery_labels.nii.gz'
const OVERLAY_BINARY = 'mask.nii.gz'

// ─── Crosshair label logic ────────────────────────────────────────────────────
/**
 * Given the NiiVue instance and the list of artery segments (from analyze_response),
 * determine which artery is closest to the current crosshair world position.
 * Returns the ARTERY_META entry, or null if none close enough.
 */
function getArteryAtCrosshair(nv, segments) {
  if (!nv || !nv.volumes?.length || !segments) return null
  try {
    const mm = nv.frac2mm(nv.scene.crosshairPos)
    // Each segment has { voxel_count, visible, data: [[x,y,z], ...] }
    // We work in voxel space – convert mm back to voxel
    const vol = nv.volumes[0]
    if (!vol) return null

    let best = null, bestDist = Infinity

    for (const meta of ARTERY_META) {
      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue
      // sample up to 300 voxels for speed
      const step = Math.max(1, Math.floor(seg.data.length / 300))
      for (let i = 0; i < seg.data.length; i += step) {
        const [xi, yi, zi] = seg.data[i]
        const wmm = vol.vox2mm([xi, yi, zi])
        const dx = wmm[0] - mm[0]
        const dy = wmm[1] - mm[1]
        const dz = wmm[2] - mm[2]
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
        if (dist < bestDist) { bestDist = dist; best = meta }
      }
    }
    // Only label if within ~8 mm
    return bestDist < 8 ? best : null
  } catch { return null }
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function NiftiViewer({
  originalFile,
  maskedBlob,
  overlayMeta,
  /** analyzeResponse – the full parsed analyze_response JSON (optional) */
  analyzeResponse,
}) {
  const canvasRef      = useRef(null)
  const labelCanvasRef = useRef(null)   // 2-D overlay canvas for artery labels
  const nvRef          = useRef(null)
  const rafRef         = useRef(null)

  const [sliceType,   setSliceType]   = useState(3)   // default: Multi
  const [maskOpacity, setMaskOpacity] = useState(0.85)
  // MRI base layer opacity – lighter by default so vessels pop
  const [mriOpacity,  setMriOpacity]  = useState(0.35)
  const [initialized, setInitialized] = useState(false)
  const [loadError,   setLoadError]   = useState(null)
  const [clipDepth,   setClipDepth]   = useState(-1)
  const [volumesReady, setVolumesReady] = useState(0)
  // Which artery is under the crosshair right now
  const [activeArtery, setActiveArtery] = useState(null)
  // Toggle individual arteries on/off
  const [hiddenArteries, setHiddenArteries] = useState(new Set())

  const arteryLabelLut  = useMemo(() => buildArteryLabelLut(), [])
  const isLabeledOverlay = overlayMeta?.kind === 'artery_labels'
  const segments         = analyzeResponse?.binary_segments ?? null
  const is3D             = sliceType === 4

  // visible artery list derived from segments
  const visibleArteries = useMemo(() =>
    ARTERY_META.filter(m => segments ? segments[m.key]?.visible : true),
    [segments]
  )

  // ── Init NiiVue ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const nv = new Niivue({
      show3Dcrosshair:     true,
      backColor:           [0.02, 0.02, 0.04, 1],
      crosshairColor:      [0, 0.9, 0.9, 0.8],
      selectionBoxColor:   [1, 1, 1, 0.4],
      clipPlaneColor:      [0.6, 0, 0.8, 0.5],
      isColorbar:          false,
      dragMode:            nv?.dragModes?.contrast ?? 1,
    })
    nv.attachToCanvas(canvas)
    nvRef.current = nv
    setInitialized(true)
    return () => { nvRef.current = null; cancelAnimationFrame(rafRef.current) }
  }, [])

  // ── Load volumes ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!initialized || !nvRef.current) return
    setLoadError(null)
    const nv = nvRef.current
    const objectUrls = []
    const volumes = []

    if (originalFile) {
      const url = URL.createObjectURL(originalFile)
      objectUrls.push(url)
      volumes.push({ url, name: originalFile.name, colormap: 'gray', opacity: mriOpacity })
    }

    if (maskedBlob) {
      const url = URL.createObjectURL(maskedBlob)
      objectUrls.push(url)
      if (isLabeledOverlay) {
        volumes.push({
          url, name: OVERLAY_LABEL,
          colormap: 'gray', opacity: maskOpacity,
          colormapLabel: arteryLabelLut,
        })
      } else {
        volumes.push({
          url, name: OVERLAY_BINARY,
          colormap: 'hot', opacity: maskOpacity,
          cal_min: 0.1, cal_max: 1,
        })
      }
    }

    if (volumes.length === 0) return

    nv.loadVolumes(volumes)
      .then(() => {
        objectUrls.forEach(u => URL.revokeObjectURL(u))
        setVolumesReady(n => n + 1)
      })
      .catch(e => {
        objectUrls.forEach(u => URL.revokeObjectURL(u))
        setLoadError(e?.message ?? 'Failed to load NIFTI file')
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, originalFile, maskedBlob])

  // ── Sync mask colormap / opacity dynamically ───────────────────────────────
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const idx = nv.volumes.findIndex(v => v.name === OVERLAY_BINARY || v.name === OVERLAY_LABEL)
    if (idx !== -1) {
      nv.setOpacity(idx, maskOpacity)
      nv.updateGL?.()
    }
  }, [maskOpacity])

  // ── Sync MRI base opacity ──────────────────────────────────────────────────
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const idx = nv.volumes.findIndex(v => v.name !== OVERLAY_BINARY && v.name !== OVERLAY_LABEL)
    if (idx !== -1) {
      nv.setOpacity(idx, mriOpacity)
      nv.updateGL?.()
    }
  }, [mriOpacity])

  // ── Slice type / illumination ──────────────────────────────────────────────
  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.setSliceType(sliceType)
    if (!nv.volumes?.length) return
    nv.setVolumeRenderIllumination?.(sliceType === 4 ? 0.6 : 0)
  }, [sliceType, volumesReady])

  // ── Clip plane (3-D) ───────────────────────────────────────────────────────
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !is3D || !nv.volumes?.length) return
    nv.setClipPlane([clipDepth === -1 ? 2 : clipDepth, 270, 0])
  }, [clipDepth, is3D, volumesReady])

  // ── 2-D label canvas: draw artery name near crosshair ─────────────────────
  const drawLabelCanvas = useCallback(() => {
    const lc = labelCanvasRef.current
    const nv = nvRef.current
    if (!lc || !nv) return
    const ctx = lc.getContext('2d')
    ctx.clearRect(0, 0, lc.width, lc.height)

    if (!isLabeledOverlay || is3D || !segments) return

    // crosshair canvas position
    const cp = nv.scene?.crosshairPos
    if (!cp) return
    const x = cp[0] * lc.width
    const y = (1 - cp[1]) * lc.height

    const artery = getArteryAtCrosshair(nv, segments)
    if (!artery) return

    const [r, g, b] = artery.rgb
    const label = artery.name

    ctx.save()
    ctx.font = 'bold 13px Inter, system-ui, sans-serif'
    const tw = ctx.measureText(label).width
    const px = Math.min(x + 14, lc.width - tw - 10)
    const py = Math.max(y - 8, 18)

    // pill background
    ctx.beginPath()
    ctx.roundRect(px - 5, py - 14, tw + 10, 20, 5)
    ctx.fillStyle = `rgba(${r},${g},${b},0.85)`
    ctx.fill()

    ctx.fillStyle = '#fff'
    ctx.fillText(label, px, py)
    ctx.restore()

    setActiveArtery(artery)
  }, [isLabeledOverlay, is3D, segments])

  // Poll crosshair position at ~30 fps for label updates
  useEffect(() => {
    if (!isLabeledOverlay || is3D) return
    const tick = () => {
      drawLabelCanvas()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isLabeledOverlay, is3D, drawLabelCanvas, volumesReady])

  // Sync label canvas size to NiiVue canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const lc     = labelCanvasRef.current
    if (!canvas || !lc) return
    const ro = new ResizeObserver(() => {
      lc.width  = canvas.offsetWidth
      lc.height = canvas.offsetHeight
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── Toggle artery visibility in the label LUT ──────────────────────────────
  const toggleArtery = useCallback((key) => {
    setHiddenArteries(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      // Optionally modulate opacity of that label in future NiiVue versions
      return next
    })
  }, [])

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-[#070708]">

      {/* ── Top toolbar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-900/90 border-b border-gray-800 shrink-0 backdrop-blur">

        {/* Slice-view buttons */}
        <div className="flex gap-1">
          {SLICE_VIEWS.map(v => (
            <button
              key={v.value}
              onClick={() => setSliceType(v.value)}
              className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
                sliceType === v.value
                  ? 'bg-cyan-400 text-black shadow-lg shadow-cyan-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        {/* MRI opacity */}
        <label className="text-xs text-gray-500">MRI:</label>
        <input
          type="range" min={0} max={1} step={0.05} value={mriOpacity}
          onChange={e => setMriOpacity(Number(e.target.value))}
          className="w-20 accent-gray-400"
          title="MRI base layer opacity"
        />
        <span className="text-xs text-gray-500 w-6">{Math.round(mriOpacity * 100)}%</span>

        {!is3D && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            <label className="text-xs text-gray-500">Vessels:</label>
            <input
              type="range" min={0} max={1} step={0.05} value={maskOpacity}
              onChange={e => setMaskOpacity(Number(e.target.value))}
              className="w-20 accent-cyan-500"
            />
            <span className="text-xs text-gray-500 w-6">{Math.round(maskOpacity * 100)}%</span>
          </>
        )}

        {is3D && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            <label className="text-xs text-gray-500">Clip:</label>
            <input
              type="range" min={-1} max={1} step={0.01} value={clipDepth}
              onChange={e => setClipDepth(Number(e.target.value))}
              className="w-28 accent-purple-400"
            />
            <button
              onClick={() => setClipDepth(-1)}
              className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
            >
              Reset
            </button>
            <span className="ml-auto text-xs text-gray-600 hidden sm:block">
              Drag to rotate · Scroll to zoom
            </span>
          </>
        )}
      </div>

      {/* ── Artery legend / toggle strip ────────────────────────────────── */}
      {maskedBlob && isLabeledOverlay && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2
                        bg-gray-950/80 border-b border-gray-800 shrink-0 max-h-28 overflow-y-auto">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide mr-1">
            Arteries
          </span>
          {ARTERY_META.map(meta => {
            const isVisible = segments ? segments[meta.key]?.visible : true
            const isHidden  = hiddenArteries.has(meta.key)
            if (!isVisible) return null   // artery not present in this scan
            return (
              <button
                key={meta.key}
                onClick={() => toggleArtery(meta.key)}
                title={isHidden ? `Show ${meta.name}` : `Hide ${meta.name}`}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px]
                  font-medium transition-all select-none
                  ${isHidden
                    ? 'border-gray-700 bg-gray-800/50 text-gray-600 opacity-50'
                    : 'border-white/10 bg-gray-900 text-gray-300 hover:bg-gray-800'
                  }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: rgbStr(meta.rgb),
                           boxShadow: isHidden ? 'none' : `0 0 4px ${rgbStr(meta.rgb)}` }}
                />
                {meta.name}
                {segments?.[meta.key]?.voxel_count
                  ? <span className="text-gray-600 text-[9px] ml-0.5">
                      {(segments[meta.key].voxel_count / 1000).toFixed(1)}k
                    </span>
                  : null
                }
              </button>
            )
          })}
        </div>
      )}

      {/* ── Simple legend for non-labeled or base layer ──────────────────── */}
      {!is3D && (
        <div className="flex gap-4 px-3 py-1.5 bg-gray-950/70 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-gray-400/60" />
            <span className="text-xs text-gray-500">MRI</span>
            <span className="text-[10px] text-gray-600">({Math.round(mriOpacity * 100)}%)</span>
          </div>
          {maskedBlob && (
            <div className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-sm"
                style={{
                  background: isLabeledOverlay
                    ? 'linear-gradient(90deg,rgb(51,153,255),rgb(255,204,0),rgb(255,128,0))'
                    : '#f97316',
                }}
              />
              <span className="text-xs text-gray-500">
                {isLabeledOverlay ? 'Labeled vessels' : 'Vessel mask'}
              </span>
            </div>
          )}
          {activeArtery && isLabeledOverlay && (
            <div className="ml-auto flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: rgbStr(activeArtery.rgb) }}
              />
              <span className="text-xs font-semibold" style={{ color: rgbStr(activeArtery.rgb) }}>
                {activeArtery.name}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Canvas area ─────────────────────────────────────────────────── */}
      <div className="flex-1 relative min-h-0">
        {/* NiiVue WebGL canvas */}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* 2-D label overlay canvas */}
        <canvas
          ref={labelCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ mixBlendMode: 'normal' }}
        />

        {/* Error overlay */}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3
                            text-sm text-red-300 max-w-xs text-center">
              {loadError}
            </div>
          </div>
        )}

        {/* Hover tooltip: crosshair artery label (also shown in legend bar) */}
        {activeArtery && !is3D && isLabeledOverlay && (
          <div
            className="absolute bottom-3 right-3 z-10 flex items-center gap-2
                       px-3 py-1.5 rounded-lg text-xs font-bold backdrop-blur-sm
                       border border-white/10 shadow-xl"
            style={{
              background: `rgba(${activeArtery.rgb.join(',')},0.2)`,
              color: rgbStr(activeArtery.rgb),
              borderColor: `rgba(${activeArtery.rgb.join(',')},0.4)`,
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: rgbStr(activeArtery.rgb),
                       boxShadow: `0 0 6px ${rgbStr(activeArtery.rgb)}` }}
            />
            {activeArtery.name}
          </div>
        )}
      </div>
    </div>
  )
}
