import { useEffect, useRef, useState } from 'react'
import { Niivue } from '@niivue/niivue'

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

export default function NiftiViewer({ originalFile, maskedBlob }) {
  const canvasRef = useRef(null)
  const nvRef = useRef(null)
  const [sliceType, setSliceType] = useState(3)
  const [maskColormap, setMaskColormap] = useState('hot')
  const [maskOpacity, setMaskOpacity] = useState(0.6)
  const [initialized, setInitialized] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [clipDepth, setClipDepth] = useState(-1)

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
      volumes.push({ url, name: originalFile.name, colormap: 'gray', opacity: 1 })
    }

    if (maskedBlob) {
      const url = URL.createObjectURL(maskedBlob)
      objectUrls.push(url)
      volumes.push({ url, name: 'mask.nii.gz', colormap: maskColormap, opacity: maskOpacity, cal_min: 0.1, cal_max: 1 })
    }

    if (volumes.length === 0) return

    nv.loadVolumes(volumes)
      .then(() => { objectUrls.forEach((u) => URL.revokeObjectURL(u)) })
      .catch((e) => {
        objectUrls.forEach((u) => URL.revokeObjectURL(u))
        setLoadError(e?.message ?? 'Failed to load NIFTI file')
      })
  }, [initialized, originalFile, maskedBlob, maskColormap, maskOpacity])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.setSliceType(sliceType)
    if (sliceType === 4) {
      nv.setVolumeRenderIllumination(0.6)
    }
  }, [sliceType])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !is3D) return
    nv.setClipPlane([clipDepth === -1 ? 2 : clipDepth, 270, 0])
  }, [clipDepth, is3D])

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
      {!is3D && (
        <div className="flex gap-4 px-3 py-1.5 bg-gray-950 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-gray-400" />
            <span className="text-xs text-gray-500">Original MRI</span>
          </div>
          {maskedBlob && (
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-orange-500" />
              <span className="text-xs text-gray-500">Lesion Mask</span>
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
