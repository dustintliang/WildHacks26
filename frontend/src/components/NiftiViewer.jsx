import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NVImage, Niivue, cmapper } from '@niivue/niivue'

const SLICE_VIEWS = [
  { label: 'Axial', value: 0 },
  { label: 'Coronal', value: 1 },
  { label: 'Sagittal', value: 2 },
  { label: 'Multi', value: 3 },
  { label: '3D', value: 4 },
]

export const ARTERY_META = [
  { id: 1, key: 'left_ICA', name: 'L-ICA', rgb: [51, 153, 255] },
  { id: 2, key: 'right_ICA', name: 'R-ICA', rgb: [0, 102, 204] },
  { id: 3, key: 'left_MCA', name: 'L-MCA', rgb: [0, 204, 102] },
  { id: 4, key: 'right_MCA', name: 'R-MCA', rgb: [0, 153, 51] },
  { id: 5, key: 'left_ACA', name: 'L-ACA', rgb: [255, 204, 0] },
  { id: 6, key: 'right_ACA', name: 'R-ACA', rgb: [204, 153, 0] },
  { id: 7, key: 'left_PCA', name: 'L-PCA', rgb: [204, 51, 204] },
  { id: 8, key: 'right_PCA', name: 'R-PCA', rgb: [153, 0, 153] },
  { id: 9, key: 'basilar', name: 'Basilar', rgb: [255, 128, 0] },
  { id: 10, key: 'left_vertebral', name: 'L-Vert', rgb: [102, 204, 204] },
  { id: 11, key: 'right_vertebral', name: 'R-Vert', rgb: [51, 153, 153] },
]

const OVERLAY_LABEL = 'artery_labels.nii.gz'
const OVERLAY_BINARY = 'mask.nii.gz'

function rgbStr([r, g, b]) {
  return `rgb(${r},${g},${b})`
}

/**
 * Generate VesselBoost-style discrete colormap LUT for NiiVue.
 * Binary segmentation: background (0) → transparent, vessel (1) → red (255, 50, 50).
 * Ported from vesselboost-webapp/web/js/app/labels.js
 */
function generateVesselBoostColormap() {
  const size = 256
  const R = new Array(size).fill(0)
  const G = new Array(size).fill(0)
  const B = new Array(size).fill(0)
  const A = new Array(size).fill(0)

  // NiiVue maps voxel values linearly through the LUT:
  // voxel 0 (cal_min) → index 0, voxel 1 (cal_max) → index 255
  // So vessel (value=1) maps to the last index (255)
  R[255] = 255
  G[255] = 50
  B[255] = 50
  A[255] = 255

  return { R, G, B, A, min: 0, max: 1 }
}

/**
 * Compute auto-contrast window using histogram-based percentiles.
 * Ported from vesselboost-webapp/web/js/modules/ui/percentile.js
 */
function computeAutoWindow(img) {
  const LOW_PCT = 0.02
  const HIGH_PCT = 0.998
  const N_BINS = 4096

  if (!img || img.length === 0) return { low: 0, high: 1, min: 0, max: 1 }

  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < img.length; i++) {
    const v = img[i]
    if (v < min) min = v
    if (v > max) max = v
  }

  if (!isFinite(min) || !isFinite(max)) return { low: 0, high: 1, min: 0, max: 1 }
  if (max <= min) return { low: min, high: min + 1, min, max: min + 1 }

  const bins = new Uint32Array(N_BINS)
  const scale = (N_BINS - 1) / (max - min)
  for (let i = 0; i < img.length; i++) {
    bins[Math.round((img[i] - min) * scale)]++
  }

  const lowTarget = Math.floor(img.length * LOW_PCT)
  const highTarget = Math.floor(img.length * HIGH_PCT)
  let cumulative = 0
  let low = min
  let high = max

  for (let i = 0; i < N_BINS; i++) {
    cumulative += bins[i]
    if (low === min && cumulative >= lowTarget) {
      low = min + i / scale
    }
    if (cumulative >= highTarget) {
      high = min + i / scale
      break
    }
  }

  return { low, high, min, max }
}

function buildArteryLabelLut(hiddenArteries) {
  const R = [0]
  const G = [0]
  const B = [0]
  const labels = ['']

  ARTERY_META.forEach(({ key, rgb: [r, g, b], name }) => {
    if (hiddenArteries.has(key)) {
      R.push(0)
      G.push(0)
      B.push(0)
    } else {
      R.push(r)
      G.push(g)
      B.push(b)
    }
    labels.push(name)
  })

  return cmapper.makeLabelLut({ R, G, B, labels })
}

function getBestWindow(volume) {
  const candidates = [
    [volume?.robust_min, volume?.robust_max],
    [volume?.cal_min, volume?.cal_max],
    [volume?.global_min, volume?.global_max],
  ]

  for (const [min, max] of candidates) {
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      return [min, max]
    }
  }

  return [0, 1]
}

function configureBaseVolume(volume) {
  const [calMin, calMax] = getBestWindow(volume)
  volume.colormap = 'gray'
  volume.cal_min = calMin
  volume.cal_max = calMax
  if (volume.hdr) {
    volume.hdr.cal_min = calMin
    volume.hdr.cal_max = calMax
  }
}

function configureOverlayVolume(volume, isLabeledOverlay, arteryLabelLut) {
  if (isLabeledOverlay) {
    volume.colormap = 'gray'
    volume.colormapLabel = arteryLabelLut
    volume.cal_min = 0
    volume.cal_max = ARTERY_META.length
    if (volume.hdr) {
      volume.hdr.cal_min = 0
      volume.hdr.cal_max = ARTERY_META.length
    }
    return
  }

  volume.colormap = 'vesselboost'
  volume.cal_min = 0
  volume.cal_max = 1
  if (volume.hdr) {
    volume.hdr.cal_min = 0
    volume.hdr.cal_max = 1
  }
}

function createOverlayFile(maskedBlob, isLabeledOverlay) {
  return new File(
    [maskedBlob],
    isLabeledOverlay ? OVERLAY_LABEL : OVERLAY_BINARY,
    { type: 'application/octet-stream' }
  )
}

function getArteryAtCrosshair(nv, segments, hiddenArteries) {
  if (!nv || !nv.volumes?.length || !segments) return null

  try {
    const mm = nv.frac2mm(nv.scene.crosshairPos)
    const vol = nv.volumes[0]
    if (!vol) return null

    let best = null
    let bestDist = Infinity

    for (const meta of ARTERY_META) {
      if (hiddenArteries.has(meta.key)) continue

      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue

      const step = Math.max(1, Math.floor(seg.data.length / 300))
      for (let i = 0; i < seg.data.length; i += step) {
        const [xi, yi, zi] = seg.data[i]
        const wmm = vol.vox2mm([xi, yi, zi])
        const dx = wmm[0] - mm[0]
        const dy = wmm[1] - mm[1]
        const dz = wmm[2] - mm[2]
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist < bestDist) {
          bestDist = dist
          best = meta
        }
      }
    }

    return bestDist < 8 ? best : null
  } catch {
    return null
  }
}

export default function NiftiViewer({
  originalFile,
  maskedBlob,
  overlayMeta,
  analyzeResponse,
}) {
  const canvasRef = useRef(null)
  const labelCanvasRef = useRef(null)
  const nvRef = useRef(null)
  const loadRequestRef = useRef(0)

  const [sliceType, setSliceType] = useState(3)
  const [maskOpacity, setMaskOpacity] = useState(0.25)
  const [mriOpacity, setMriOpacity] = useState(1)
  const [initialized, setInitialized] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [clipDepth, setClipDepth] = useState(-1)
  const [volumesReady, setVolumesReady] = useState(0)
  const [activeArtery, setActiveArtery] = useState(null)
  const [hiddenArteries, setHiddenArteries] = useState(new Set())
  const [windowMin, setWindowMin] = useState(0)
  const [windowMax, setWindowMax] = useState(1)
  const [globalRange, setGlobalRange] = useState([0, 1])

  const isLabeledOverlay = overlayMeta?.kind === 'artery_labels'
  const is3D = sliceType === 4
  const segments = analyzeResponse?.binary_segments ?? null
  const arteryLabelLut = useMemo(
    () => buildArteryLabelLut(hiddenArteries),
    [hiddenArteries]
  )

  const drawLabelCanvas = useCallback(() => {
    const labelCanvas = labelCanvasRef.current
    const nv = nvRef.current
    if (!labelCanvas || !nv) return

    const ctx = labelCanvas.getContext('2d')
    ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height)

    if (!isLabeledOverlay || is3D || !segments || !nv.volumes?.length) {
      setActiveArtery(null)
      return
    }

    const crosshair = nv.scene?.crosshairPos
    if (!crosshair) {
      setActiveArtery(null)
      return
    }

    const artery = getArteryAtCrosshair(nv, segments, hiddenArteries)
    setActiveArtery(artery)
    if (!artery) return

    const x = crosshair[0] * labelCanvas.width
    const y = (1 - crosshair[1]) * labelCanvas.height
    const [r, g, b] = artery.rgb
    const label = artery.name

    ctx.save()
    ctx.font = 'bold 13px Inter, system-ui, sans-serif'
    const textWidth = ctx.measureText(label).width
    const px = Math.min(x + 14, labelCanvas.width - textWidth - 10)
    const py = Math.max(y - 8, 18)

    ctx.beginPath()
    ctx.roundRect(px - 5, py - 14, textWidth + 10, 20, 5)
    ctx.fillStyle = `rgba(${r},${g},${b},0.85)`
    ctx.fill()

    ctx.fillStyle = '#fff'
    ctx.fillText(label, px, py)
    ctx.restore()
  }, [hiddenArteries, is3D, isLabeledOverlay, segments])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const nv = new Niivue({
      trustCalMinMax: false,
      show3Dcrosshair: false,
      backColor: [0.02, 0.02, 0.04, 1],
      crosshairColor: [0.23, 0.51, 0.96, 1.0],
      crosshairWidth: 0.75,
      selectionBoxColor: [1, 1, 1, 0.4],
      clipPlaneColor: [0.6, 0, 0.8, 0.5],
      isColorbar: false,
      dragToMeasure: false,
      textHeight: 0.03,
    })

    nv.opts.multiplanarShowRender = 1
    nv.dragMode = nv.dragModes?.contrast ?? 1
    nv.attachToCanvas(canvas)

    // Register the VesselBoost custom colormap (ported from vesselboost-webapp)
    try {
      nv.addColormap('vesselboost', generateVesselBoostColormap())
    } catch (e) {
      console.warn('Could not register vesselboost colormap:', e)
    }

    nv.onLocationChange = () => drawLabelCanvas()
    nvRef.current = nv
    setInitialized(true)

    return () => {
      loadRequestRef.current += 1
      if (nvRef.current === nv) {
        nvRef.current = null
      }
    }
  }, [drawLabelCanvas])

  useEffect(() => {
    const canvas = canvasRef.current
    const labelCanvas = labelCanvasRef.current
    if (!canvas || !labelCanvas) return

    const syncSize = () => {
      labelCanvas.width = canvas.offsetWidth
      labelCanvas.height = canvas.offsetHeight
      drawLabelCanvas()
    }

    syncSize()
    const ro = new ResizeObserver(syncSize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [drawLabelCanvas])

  // ── Window/level control helpers (ported from vesselboost-webapp) ──

  const syncWindowFromNv = useCallback(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const vol = nv.volumes[0]
    const gMin = vol.global_min ?? 0
    const gMax = vol.global_max ?? 1
    setGlobalRange([gMin, gMax])
    setWindowMin(vol.cal_min ?? gMin)
    setWindowMax(vol.cal_max ?? gMax)
  }, [])

  const pctMin = globalRange[1] > globalRange[0]
    ? Math.max(0, Math.min(100, ((windowMin - globalRange[0]) / (globalRange[1] - globalRange[0])) * 100))
    : 0
  const pctMax = globalRange[1] > globalRange[0]
    ? Math.max(0, Math.min(100, ((windowMax - globalRange[0]) / (globalRange[1] - globalRange[0])) * 100))
    : 100

  const handleSliderMin = useCallback((e) => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const vol = nv.volumes[0]
    const gMin = vol.global_min ?? 0
    const gMax = vol.global_max ?? 1
    const range = gMax - gMin || 1
    const curMaxPct = Math.max(0, Math.min(100, ((vol.cal_max - gMin) / range) * 100))
    let pct = Number(e.target.value)
    if (pct > curMaxPct - 1) pct = curMaxPct - 1
    const newMin = gMin + (pct / 100) * range
    vol.cal_min = newMin
    nv.updateGLVolume()
    setWindowMin(newMin)
  }, [])

  const handleSliderMax = useCallback((e) => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const vol = nv.volumes[0]
    const gMin = vol.global_min ?? 0
    const gMax = vol.global_max ?? 1
    const range = gMax - gMin || 1
    const curMinPct = Math.max(0, Math.min(100, ((vol.cal_min - gMin) / range) * 100))
    let pct = Number(e.target.value)
    if (pct < curMinPct + 1) pct = curMinPct + 1
    const newMax = gMin + (pct / 100) * range
    vol.cal_max = newMax
    nv.updateGLVolume()
    setWindowMax(newMax)
  }, [])

  const handleInputMin = useCallback((e) => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const val = parseFloat(e.target.value)
    if (isNaN(val)) return
    const vol = nv.volumes[0]
    vol.cal_min = val
    nv.updateGLVolume()
    setWindowMin(val)
  }, [])

  const handleInputMax = useCallback((e) => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const val = parseFloat(e.target.value)
    if (isNaN(val)) return
    const vol = nv.volumes[0]
    vol.cal_max = val
    nv.updateGLVolume()
    setWindowMax(val)
  }, [])

  const handleAutoContrast = useCallback(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return
    const vol = nv.volumes[0]
    const { low, high, min: rawMin, max: rawMax } = computeAutoWindow(vol.img)

    let scaledLow = low
    let scaledHigh = high
    const rawRange = rawMax - rawMin
    const scaledRange = (vol.global_max ?? 1) - (vol.global_min ?? 0)
    if (rawRange > 0 && scaledRange > 0) {
      const slope = scaledRange / rawRange
      const inter = (vol.global_min ?? 0) - rawMin * slope
      scaledLow = low * slope + inter
      scaledHigh = high * slope + inter
    }

    vol.cal_min = scaledLow
    vol.cal_max = scaledHigh
    nv.updateGLVolume()
    setWindowMin(scaledLow)
    setWindowMax(scaledHigh)
  }, [])

  useEffect(() => {
    if (!initialized || !nvRef.current) return

    const nv = nvRef.current
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    setLoadError(null)
    setVolumesReady(0)
    setActiveArtery(null)

    const loadVolumes = async () => {
      try {
        await nv.loadVolumes([])

        let loadedCount = 0

        if (originalFile) {
          const baseVolume = await NVImage.loadFromFile({
            file: originalFile,
            name: originalFile.name,
            colormap: 'gray',
            opacity: 1,
            trustCalMinMax: false,
            ignoreZeroVoxels: true,
            percentileFrac: 0.02,
          })

          if (loadRequestRef.current !== requestId) return

          configureBaseVolume(baseVolume)
          nv.addVolume(baseVolume)
          loadedCount += 1
        }

        if (maskedBlob) {
          const overlayFile = createOverlayFile(maskedBlob, isLabeledOverlay)
          const overlayVolume = await NVImage.loadFromFile({
            file: overlayFile,
            name: overlayFile.name,
            colormap: isLabeledOverlay ? 'gray' : 'vesselboost',
            opacity: 1,
            trustCalMinMax: false,
            ignoreZeroVoxels: true,
          })

          if (loadRequestRef.current !== requestId) return

          configureOverlayVolume(overlayVolume, isLabeledOverlay, arteryLabelLut)
          nv.addVolume(overlayVolume)
          loadedCount += 1
        }

        if (!loadedCount) {
          nv.drawScene()
          setVolumesReady(0)
          return
        }

        nv.setSliceType(sliceType)

        if (nv.volumes[0]) {
          nv.setOpacity(0, mriOpacity)
        }

        if (nv.volumes[1]) {
          nv.setOpacity(1, maskOpacity)
        }

        nv.updateGLVolume?.()
        nv.drawScene()
        drawLabelCanvas()
        syncWindowFromNv()
        setVolumesReady(loadedCount)
      } catch (error) {
        if (loadRequestRef.current !== requestId) return
        setLoadError(error?.message ?? 'Failed to load NIfTI file')
        setVolumesReady(0)
      }
    }

    loadVolumes()
  }, [
    arteryLabelLut,
    drawLabelCanvas,
    initialized,
    isLabeledOverlay,
    maskedBlob,
    maskOpacity,
    mriOpacity,
    originalFile,
    sliceType,
    syncWindowFromNv,
  ])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return

    nv.setSliceType(sliceType)
    nv.setVolumeRenderIllumination?.(sliceType === 4 ? 0.6 : 0)
    drawLabelCanvas()
  }, [drawLabelCanvas, sliceType, volumesReady])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !nv.volumes?.length) return

    nv.setOpacity(0, mriOpacity)
    nv.updateGLVolume?.()
    nv.drawScene()
  }, [mriOpacity, volumesReady])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length < 2) return

    nv.setOpacity(1, maskOpacity)
    nv.updateGLVolume?.()
    nv.drawScene()
  }, [maskOpacity, volumesReady])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length < 2 || !isLabeledOverlay) return

    const overlayVolume = nv.volumes[1]
    configureOverlayVolume(overlayVolume, true, arteryLabelLut)
    nv.updateGLVolume?.()
    nv.drawScene()
    drawLabelCanvas()
  }, [arteryLabelLut, drawLabelCanvas, isLabeledOverlay, volumesReady])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !is3D || !nv.volumes?.length) return

    nv.setClipPlane([clipDepth === -1 ? 2 : clipDepth, 270, 0])
  }, [clipDepth, is3D, volumesReady])

  const toggleArtery = useCallback((key) => {
    setHiddenArteries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  return (
    <div className="flex flex-col h-full bg-[#070708]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-900/90 border-b border-gray-800 shrink-0 backdrop-blur">
        <div className="flex gap-1">
          {SLICE_VIEWS.map((view) => (
            <button
              key={view.value}
              onClick={() => setSliceType(view.value)}
              className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
                sliceType === view.value
                  ? 'bg-cyan-400 text-black shadow-lg shadow-cyan-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        {/* ── Window/Level dual-range slider (ported from vesselboost-webapp) ── */}
        <input
          type="number"
          step="any"
          value={Number(windowMin.toPrecision(4))}
          onChange={handleInputMin}
          title="Window minimum"
          className="w-[68px] px-1 py-0.5 text-[11px] text-center bg-gray-800 border border-gray-700 rounded text-gray-300 focus:border-blue-500 focus:outline-none tabular-nums"
          style={{ MozAppearance: 'textfield' }}
        />
        <div className="relative w-[120px] h-5 flex items-center shrink-0">
          {/* Track background */}
          <div className="absolute w-full h-1 bg-gray-700 rounded-full pointer-events-none" />
          {/* Selected range highlight */}
          <div
            className="absolute h-1 rounded-full pointer-events-none"
            style={{
              left: `${pctMin}%`,
              width: `${Math.max(0, pctMax - pctMin)}%`,
              background: '#3b82f6',
            }}
          />
          {/* Min slider */}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={pctMin}
            onChange={handleSliderMin}
            className="window-range-slider"
            style={{ zIndex: 4 }}
          />
          {/* Max slider */}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={pctMax}
            onChange={handleSliderMax}
            className="window-range-slider"
            style={{ zIndex: 3 }}
          />
        </div>
        <input
          type="number"
          step="any"
          value={Number(windowMax.toPrecision(4))}
          onChange={handleInputMax}
          title="Window maximum"
          className="w-[68px] px-1 py-0.5 text-[11px] text-center bg-gray-800 border border-gray-700 rounded text-gray-300 focus:border-blue-500 focus:outline-none tabular-nums"
          style={{ MozAppearance: 'textfield' }}
        />
        <button
          onClick={handleAutoContrast}
          title="Auto-contrast (percentile-based)"
          className="px-2 py-0.5 text-[11px] rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white border border-gray-700 font-medium"
        >
          Auto
        </button>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        <label className="text-xs text-gray-500">MRI:</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={mriOpacity}
          onChange={(e) => setMriOpacity(Number(e.target.value))}
          className="w-20 accent-gray-400"
          title="MRI base layer opacity"
        />
        <span className="text-xs text-gray-500 w-6">{Math.round(mriOpacity * 100)}%</span>

        {!is3D && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            <label className="text-xs text-gray-500">Vessels:</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={maskOpacity}
              onChange={(e) => setMaskOpacity(Number(e.target.value))}
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
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={clipDepth}
              onChange={(e) => setClipDepth(Number(e.target.value))}
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

      {maskedBlob && isLabeledOverlay && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 bg-gray-950/80 border-b border-gray-800 shrink-0 max-h-28 overflow-y-auto">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide mr-1">
            Arteries
          </span>
          {ARTERY_META.map((meta) => {
            const isVisible = segments ? segments[meta.key]?.visible : true
            const isHidden = hiddenArteries.has(meta.key)
            if (!isVisible) return null

            return (
              <button
                key={meta.key}
                onClick={() => toggleArtery(meta.key)}
                title={isHidden ? `Show ${meta.name}` : `Hide ${meta.name}`}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium transition-all select-none ${
                  isHidden
                    ? 'border-gray-700 bg-gray-800/50 text-gray-600 opacity-50'
                    : 'border-white/10 bg-gray-900 text-gray-300 hover:bg-gray-800'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    background: rgbStr(meta.rgb),
                    boxShadow: isHidden ? 'none' : `0 0 4px ${rgbStr(meta.rgb)}`,
                  }}
                />
                {meta.name}
                {segments?.[meta.key]?.voxel_count ? (
                  <span className="text-gray-600 text-[9px] ml-0.5">
                    {(segments[meta.key].voxel_count / 1000).toFixed(1)}k
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}

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
                    : 'rgb(255, 50, 50)',
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

      <div className="flex-1 relative min-h-0">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        <canvas
          ref={labelCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ mixBlendMode: 'normal' }}
        />

        {!loadError && !originalFile && !maskedBlob && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-10">
            <div className="bg-gray-950/80 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-300 max-w-xs text-center">
              Load a scan to render the MRI viewer.
            </div>
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-300 max-w-xs text-center">
              {loadError}
            </div>
          </div>
        )}

        {activeArtery && !is3D && isLabeledOverlay && (
          <div
            className="absolute bottom-3 right-3 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold backdrop-blur-sm border border-white/10 shadow-xl"
            style={{
              background: `rgba(${activeArtery.rgb.join(',')},0.2)`,
              color: rgbStr(activeArtery.rgb),
              borderColor: `rgba(${activeArtery.rgb.join(',')},0.4)`,
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: rgbStr(activeArtery.rgb),
                boxShadow: `0 0 6px ${rgbStr(activeArtery.rgb)}`,
              }}
            />
            {activeArtery.name}
          </div>
        )}
      </div>

      {/* Dual-range slider styles (ported from vesselboost-webapp) */}
      <style>{`
        .window-range-slider {
          position: absolute;
          width: 100%;
          height: 20px;
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          pointer-events: none;
          margin: 0;
        }
        .window-range-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          background: #3b82f6;
          border-radius: 50%;
          cursor: pointer;
          pointer-events: auto;
          border: 2px solid white;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
          position: relative;
          z-index: 10;
        }
        .window-range-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          background: #3b82f6;
          border-radius: 50%;
          cursor: pointer;
          pointer-events: auto;
          border: 2px solid white;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
        }
        .window-range-slider::-webkit-slider-runnable-track {
          background: transparent;
        }
        .window-range-slider::-moz-range-track {
          background: transparent;
        }
        /* Hide number input spinners */
        input[type="number"].tabular-nums::-webkit-outer-spin-button,
        input[type="number"].tabular-nums::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
      `}</style>
    </div>
  )
}
