import { useEffect, useMemo, useRef, useState } from 'react'
import { Niivue, cmapper } from '@niivue/niivue'

const SLICE_VIEWS = [
  { label: 'Axial', value: 0 },
  { label: 'Coronal', value: 1 },
  { label: 'Sagittal', value: 2 },
  { label: 'Multi', value: 3 },
  { label: '3D', value: 4 },
]

const MASK_COLORMAPS = [
  { label: 'Hot', value: 'hot' },
  { label: 'Red', value: 'red' },
  { label: 'Cool', value: 'cool' },
]

/** RGB 0–255 per eICAB label id 1–11 (matches backend step6_render artery colors). */
const ARTERY_LABEL_RGB = [
  [51, 153, 255],
  [0, 102, 204],
  [0, 204, 102],
  [0, 153, 51],
  [255, 204, 0],
  [204, 153, 0],
  [204, 51, 204],
  [153, 0, 153],
  [255, 128, 0],
  [102, 204, 204],
  [51, 153, 153],
]

const ARTERY_LEGEND_NAMES = [
  'L-ICA', 'R-ICA', 'L-MCA', 'R-MCA', 'L-ACA', 'R-ACA',
  'L-PCA', 'R-PCA', 'Basilar', 'L-Vert', 'R-Vert',
]

function buildArteryLabelLut() {
  const R = [0]
  const G = [0]
  const B = [0]
  const labels = ['']
  for (let i = 0; i < ARTERY_LABEL_RGB.length; i++) {
    const [r, g, b] = ARTERY_LABEL_RGB[i]
    R.push(r)
    G.push(g)
    B.push(b)
    labels.push(ARTERY_LEGEND_NAMES[i] ?? `L${i + 1}`)
  }
  return cmapper.makeLabelLut({ R, G, B, labels })
}

const OVERLAY_LABEL = 'artery_labels.nii.gz'
const OVERLAY_BINARY = 'mask.nii.gz'

export default function NiftiViewer({ originalFile, maskedBlob, overlayMeta }) {
  const canvasRef = useRef(null)
  const nvRef = useRef(null)
  const [sliceType, setSliceType] = useState(3)
  const [maskColormap, setMaskColormap] = useState('hot')
  const [maskOpacity, setMaskOpacity] = useState(0.75)
  const [initialized, setInitialized] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [clipDepth, setClipDepth] = useState(-1)
  const [volumesReady, setVolumesReady] = useState(0)

  const arteryLabelLut = useMemo(() => buildArteryLabelLut(), [])
  const isLabeledOverlay = overlayMeta?.kind === 'artery_labels'

  const is3D = sliceType === 4

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const nv = new Niivue({
      show3Dcrosshair: true,
      backColor: [0.04, 0.04, 0.06, 1],
      crosshairColor: [0, 0.85, 0.85, 1],
      selectionBoxColor: [1, 1, 1, 0.5],
      clipPlaneColor: [0.7, 0, 0.7, 0.5],
    })

    nv.attachToCanvas(canvas)
    nvRef.current = nv
    setInitialized(true)

    return () => { nvRef.current = null }
  }, [])

  useEffect(() => {
    if (!initialized || !nvRef.current) return

    setLoadError(null)
    const nv = nvRef.current
    const objectUrls = []

    const volumes = []

    if (originalFile) {
      const url = URL.createObjectURL(originalFile)
      objectUrls.push(url)
      volumes.push({ 
        url, 
        name: originalFile.name, 
        colormap: 'gray', 
        opacity: 1,
      })
    }

    if (maskedBlob) {
      const url = URL.createObjectURL(maskedBlob)
      objectUrls.push(url)
      if (isLabeledOverlay) {
        volumes.push({
          url,
          name: OVERLAY_LABEL,
          colormap: 'gray',
          opacity: maskOpacity,
          colormapLabel: arteryLabelLut,
        })
      } else {
        volumes.push({
          url,
          name: OVERLAY_BINARY,
          colormap: maskColormap,
          opacity: maskOpacity,
          cal_min: 0.1,
          cal_max: 1,
        })
      }
    }

    if (volumes.length === 0) return

    nv.loadVolumes(volumes)
      .then(() => {
        objectUrls.forEach((u) => URL.revokeObjectURL(u))
        
        // Dynamic contrast adjustment: aggressively brighten the base MRI
        if (nv.volumes.length > 0) {
          const mri = nv.volumes[0]
          
          // CRITICAL: If cal_min is <= 0, the background (0) will be rendered as semi-opaque,
          // creating a "block" look. We force it slightly above 0 to keep background transparent.
          if (mri.cal_min <= 0) {
            mri.cal_min = 0.01
          }

          const range = mri.cal_max - mri.cal_min
          if (range > 0) {
            // Pull the white-point way down (to 18%) to make the whole scan look much lighter.
            mri.cal_max = mri.cal_min + (range * 0.18)
            nv.drawScene()
          }
        }
        
        setVolumesReady((n) => n + 1)
      })
      .catch((e) => {
        objectUrls.forEach((u) => URL.revokeObjectURL(u))
        setLoadError(e?.message ?? 'Failed to load NIFTI file')
      })
  }, [initialized, originalFile, maskedBlob])

  // Update colormap and opacity dynamically without reloading volumes
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return

    const maskIndex = nv.volumes.findIndex(v => v.name === OVERLAY_BINARY || v.name === OVERLAY_LABEL)
    if (maskIndex !== -1) {
      nv.setOpacity(maskIndex, maskOpacity)
      // Only set colormap for binary mask, not labeled overlay
      if (nv.volumes[maskIndex].name === OVERLAY_BINARY) {
        nv.setColormap(nv.volumes[maskIndex].id, maskColormap)
      }
      nv.drawScene()
    }
  }, [maskColormap, maskOpacity])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.setSliceType(sliceType)
    
    if (nv.volumes.length === 0) return
    if (sliceType === 4) {
      // High-fidelity 3D "Glass Brain" settings
      nv.setVolumeRenderIllumination(1.0)
      nv.opts.isGradients = true
      nv.drawScene()
    } else {
      nv.setVolumeRenderIllumination(0)
      nv.opts.isGradients = false
      nv.drawScene()
    }
  }, [sliceType, volumesReady])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !is3D || nv.volumes.length === 0) return
    // distance 0 is center, 1 is edge. Nudge to cut through if -1.
    const d = clipDepth === -1 ? 0.15 : clipDepth
    nv.setClipPlane([d, 270, 0])
  }, [clipDepth, is3D, volumesReady])

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex gap-1">
          {SLICE_VIEWS.map((v) => (
            <button
              key={v.value}
              onClick={() => setSliceType(v.value)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                sliceType === v.value
                  ? 'bg-cyan-500 text-black'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {!is3D && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            {!isLabeledOverlay && (
              <>
                <label className="text-xs text-gray-500">Overlay:</label>
                <select
                  value={maskColormap}
                  onChange={(e) => setMaskColormap(e.target.value)}
                  className="text-xs bg-gray-800 text-gray-300 rounded px-2 py-1 border border-gray-700"
                >
                  {MASK_COLORMAPS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </>
            )}
            {isLabeledOverlay && (
              <span className="text-xs text-gray-500">Per-artery colors (label overlay)</span>
            )}
            <label className="text-xs text-gray-500">Opacity:</label>
            <input
              type="range" min={0} max={1} step={0.05} value={maskOpacity}
              onChange={(e) => setMaskOpacity(Number(e.target.value))}
              className="w-20 accent-cyan-500"
            />
            <span className="text-xs text-gray-500 w-6">{Math.round(maskOpacity * 100)}%</span>
          </>
        )}

        {is3D && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-1" />
            <label className="text-xs text-gray-500">Clip plane:</label>
            <input
              type="range" min={-1} max={1} step={0.01} value={clipDepth}
              onChange={(e) => setClipDepth(Number(e.target.value))}
              className="w-28 accent-cyan-500"
            />
            <button
              onClick={() => setClipDepth(-1)}
              className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
            >
              Reset
            </button>
            <div className="ml-auto text-xs text-gray-600 hidden sm:block">
              Click + drag to rotate · Scroll to zoom
            </div>
          </>
        )}
      </div>

      {/* Legend */}
      {maskedBlob && isLabeledOverlay && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-1.5 bg-gray-950 border-b border-gray-800 shrink-0 max-h-24 overflow-y-auto">
          <span className="text-[10px] text-gray-500 w-full sm:w-auto sm:mr-1">Arteries:</span>
          {ARTERY_LEGEND_NAMES.map((name, i) => {
            const [r, g, b] = ARTERY_LABEL_RGB[i]
            return (
              <div key={name} className="flex items-center gap-1">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0 border border-white/20"
                  style={{ background: `rgb(${r},${g},${b})` }}
                />
                <span className="text-[10px] text-gray-400">{name}</span>
              </div>
            )
          })}
        </div>
      )}

      {!is3D && (
        <div className="flex gap-4 px-3 py-1.5 bg-gray-950 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-gray-400" />
            <span className="text-xs text-gray-500">Original MRI</span>
          </div>
          {maskedBlob && (
            <div className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-sm"
                style={{
                  background: isLabeledOverlay
                    ? 'linear-gradient(90deg, rgb(51,153,255), rgb(255,204,0), rgb(255,128,0))'
                    : '#f97316',
                }}
              />
              <span className="text-xs text-gray-500">
                {isLabeledOverlay ? 'Labeled vessels' : 'Vessel mask'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Canvas */}
      <div className="flex-1 relative min-h-0">
        <canvas ref={canvasRef} className="absolute inset-0" />
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-300 max-w-xs text-center">
              {loadError}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
