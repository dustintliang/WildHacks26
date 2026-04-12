import { useState } from 'react'
import Header from './components/Header'
import UploadZone from './components/UploadZone'
import NiftiViewer from './components/NiftiViewer'
import Vessel3DViewer from './components/Vessel3DViewer'
import AnalysisPanel from './components/AnalysisPanel'

const API_BASE = 'http://127.0.0.1:8000'
const DEMO_JOB_ID = '9acd632a-8937-4fdc-8e9b-d16d8387aa6d'
const DEMO_OUTPUT_BASE = `/backend-output/${DEMO_JOB_ID}`
const DEMO_ANALYZE_URL = '/backend-assets/final_example/analyze_response.json'

const DEMO_STEPS = [
  { step: 1, action: 'Loading preprocessed scan...' },
  { step: 2, action: 'Applying vessel segmentation mask...' },
  { step: 3, action: 'Loading artery labels...' },
  { step: 4, action: 'Loading centerline data...' },
  { step: 5, action: 'Computing vessel features...' },
  { step: 6, action: 'Rendering labeled overlay...' },
  { step: 7, action: 'Loading AI report...' },
  { step: 8, action: 'Computing risk scores...' },
]

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export default function App() {
  const [phase, setPhase] = useState('upload')
  const [originalFile, setOriginalFile] = useState(null)
  const [maskedBlob, setMaskedBlob] = useState(null)
  const [overlayMeta, setOverlayMeta] = useState(null)
  const [analyzeResponse, setAnalyzeResponse] = useState(null)
  const [analysis, setAnalysis] = useState('')
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState({ step: 0, total: 8, action: 'Starting...' })
  const [segments, setSegments] = useState({})
  const [riskScores, setRiskScores] = useState({})
  const [narrativeSummary, setNarrativeSummary] = useState('')
  const [viewMode, setViewMode] = useState('mri') // 'mri' | 'vessel3d'
  const handleSubmit = async (file, isDemo = false) => {
    setError(null)
    setOriginalFile(file)
    setMaskedBlob(null)
    setOverlayMeta(null)
    setAnalyzeResponse(null)
    setAnalysis('')
    setSegments({})
    setRiskScores({})
    setNarrativeSummary('')
    setOverlayMeta(null)
    setProgress({ step: 0, total: 8, action: isDemo ? 'Loading demo data...' : 'Connecting to server...' })
    setPhase('processing')

    try {
      if (isDemo) {
        // ── Demo mode: use real pipeline artifacts from backend/output ──────
        const analyzePromise = fetch(`${DEMO_ANALYZE_URL}?t=${Date.now()}`).then(r => {
          if (!r.ok) throw new Error(`Analyze fetch ${r.status}`)
          return r.json()
        })
        const mriPromise = fetch('/backend-assets/1.nii')
          .then(r => {
            if (!r.ok) throw new Error(`MRI fetch ${r.status}`)
            return r.blob()
          })
          .catch(e => {
            console.warn('Demo MRI base load skipped:', e)
            return null
          })
        const overlayPromise = fetch(`${DEMO_OUTPUT_BASE}/${DEMO_JOB_ID}_overlay.nii.gz`)
          .then(r => {
            if (!r.ok) throw new Error(`Overlay fetch ${r.status}`)
            return r.blob()
          })
          .catch(e => {
            console.warn('Demo vessel overlay load skipped:', e)
            return null
          })

        const [analyzeData] = await Promise.all([
          analyzePromise,
        ])

        for (const s of DEMO_STEPS) {
          setProgress({ ...s, total: 8 })
          await delay(350)
        }

        const [mriBlob, overlayBlob] = await Promise.all([mriPromise, overlayPromise])
        setProgress({ step: 8, total: 8, action: 'Analysis complete!' })
        await delay(300)

        if (mriBlob && mriBlob.size > 0) {
          const mriFile = new File([mriBlob], '1.nii', { type: 'application/octet-stream' })
          setOriginalFile(mriFile)
        }
        setMaskedBlob(overlayBlob && overlayBlob.size > 0 ? overlayBlob : null)
        setOverlayMeta(overlayBlob && overlayBlob.size > 0 ? { kind: 'binary_mask' } : null)
        setAnalyzeResponse(analyzeData)
        setSegments(analyzeData.binary_segments || {})
        setRiskScores(analyzeData.risk_scores || {})
        setNarrativeSummary(analyzeData.narrative_summary || '')
        setAnalysis(analyzeData.narrative_summary || '')
        setPhase('results')
        return
      }

      // ── Live mode: upload to backend and poll ────────────────────────────
      setProgress({ step: 0, total: 8, action: 'Connecting to server...' })

      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${API_BASE}/analyze`, { method: 'POST', body: formData })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Server returned ${res.status}`)
      }

      const initialData = await res.json()
      const jobId = initialData.job_id

      let data
      while (true) {
        await delay(1000)
        const pollRes = await fetch(`${API_BASE}/results/${jobId}`)
        if (!pollRes.ok) throw new Error(`Polling failed: ${pollRes.status}`)
        data = await pollRes.json()

        if (data.status === 'processing' && data.progress) {
          setProgress(data.progress)
        }

        if (data.status === 'complete' || data.status === 'failed') break
      }

      if (data.status === 'failed') {
        throw new Error(data.message || 'Pipeline failed during processing')
      }

      setProgress({ step: 8, total: 8, action: 'Analysis complete!' })

      // Use the data retrieved from the final poll instead of doing a second fetch
      setAnalyzeResponse(data)
      setSegments(data.binary_segments || {})
      setRiskScores(data.risk_scores || {})
      setNarrativeSummary(data.narrative_summary || '')
      setAnalysis(data.narrative_summary || '')

      // Fetch severity-coded overlay NIfTI from /render/{job_id} for NiiVue
      try {
        const renderRes = await fetch(`${API_BASE}/render/${jobId}`)
        if (renderRes.ok) {
          const renderData = await renderRes.json()
          if (renderData.overlay_url) {
            const r = await fetch(`${API_BASE}${renderData.overlay_url}`)
            if (r.ok) {
              setMaskedBlob(await r.blob())
              setOverlayMeta({ kind: 'artery_labels' }) // The backend provides labeled overlays
            }
          }
        }
      } catch (e) {
        console.warn('Overlay load failed:', e)
      }
      setPhase('results')
    } catch (e) {
      console.error(e)
      setError(e.message)
      setPhase('upload')
    }
  }

  const reset = () => {
    setPhase('upload')
    setOriginalFile(null)
    setMaskedBlob(null)
    setOverlayMeta(null)
    setAnalyzeResponse(null)
    setAnalysis('')
    setSegments({})
    setRiskScores({})
    setNarrativeSummary('')
    setOverlayMeta(null)
    setError(null)
    setProgress({ step: 0, total: 8, action: 'Starting...' })
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <Header />

      <main className="flex-1 overflow-hidden">
        {phase === 'upload' && (
          <UploadZone onSubmit={handleSubmit} error={error} />
        )}

        {(phase === 'processing' || phase === 'results') && (
          <div className="flex h-full">
            <div className="flex-[3] min-w-0 flex flex-col">
              {/* View mode toggle bar */}
              {phase === 'results' && (
                <div className="flex items-center gap-1 px-3 py-2 bg-gray-900/90 border-b border-gray-800 shrink-0">
                  <button
                    onClick={() => setViewMode('mri')}
                    className={`px-3 py-1.5 text-xs rounded-lg font-semibold transition-all ${
                      viewMode === 'mri'
                        ? 'bg-cyan-400 text-black shadow-lg shadow-cyan-500/30'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      MRI + Vessel Overlay
                    </span>
                  </button>
                  <button
                    onClick={() => setViewMode('vessel3d')}
                    className={`px-3 py-1.5 text-xs rounded-lg font-semibold transition-all ${
                      viewMode === 'vessel3d'
                        ? 'bg-indigo-400 text-black shadow-lg shadow-indigo-500/30'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                      </svg>
                      3D Vessel View
                    </span>
                  </button>
                </div>
              )}

              <div className="flex-1 min-h-0">
                {viewMode === 'mri' ? (
                  <NiftiViewer
                    originalFile={originalFile}
                    maskedBlob={maskedBlob}
                    overlayMeta={overlayMeta}
                    analyzeResponse={analyzeResponse}
                  />
                ) : (
                  <Vessel3DViewer
                    analyzeResponse={analyzeResponse}
                    renderMeta={
                      analyzeResponse
                        ? undefined
                        : null
                    }
                  />
                )}
              </div>
            </div>

            <div className="flex-[2] min-w-0 border-l border-gray-800 overflow-y-auto">
              {phase === 'processing' ? (
                <ProcessingPanel progress={progress} />
              ) : (
                <AnalysisPanel
                  segments={segments}
                  riskScores={riskScores}
                  narrativeSummary={narrativeSummary}
                  onReset={reset}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function ProcessingPanel({ progress }) {
  const { step, total, action } = progress
  const pct = total > 0 ? Math.round((step / total) * 100) : 0

  const STEP_LABELS = [
    'Preprocessing',
    'Vessel Segmentation',
    'Artery Labeling',
    'Centerline Extraction',
    'Feature Analysis',
    'Slice Rendering',
    'AI Report',
    'Risk Scoring',
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-white">Analyzing Scan</h2>
        <p className="text-xs text-gray-500 mt-0.5">Cerebrovascular pipeline running...</p>
      </div>

      {/* Progress section */}
      <div className="flex-1 px-5 py-6 flex flex-col gap-6">

        {/* Big percentage display */}
        <div className="text-center">
          <span className="text-5xl font-bold tabular-nums" style={{
            background: 'linear-gradient(90deg, #22d3ee, #818cf8)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            {pct}%
          </span>
          <p className="text-xs text-gray-400 mt-2 min-h-[1.25rem] transition-all duration-500">
            {action}
          </p>
        </div>

        {/* Progress bar track */}
        <div className="relative h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, #06b6d4, #6366f1)',
              boxShadow: '0 0 12px rgba(99, 102, 241, 0.6)',
            }}
          />
          {/* Animated shimmer overlay */}
          <div
            className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)',
              animation: 'shimmer 1.8s infinite',
            }}
          />
        </div>

        {/* 8-step grid */}
        <div className="grid grid-cols-4 gap-1.5">
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1
            const isDone = stepNum < step
            const isActive = stepNum === step
            return (
              <div
                key={label}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-300 ${
                  isActive ? 'bg-indigo-950/50 border border-indigo-700/50' :
                  isDone   ? 'bg-gray-900/50 border border-gray-700/30' :
                             'border border-transparent'
                }`}
              >
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300 ${
                  isDone   ? 'bg-cyan-500 text-black' :
                  isActive ? 'border-2 border-indigo-400 text-indigo-400 animate-pulse' :
                             'border-2 border-gray-700 text-gray-700'
                }`}>
                  {isDone ? '✓' : stepNum}
                </div>
                <span className={`text-[9px] text-center leading-tight transition-colors duration-300 ${
                  isActive ? 'text-indigo-300' : isDone ? 'text-gray-500' : 'text-gray-700'
                }`}>
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        <p className="text-xs text-gray-600 leading-relaxed">
          CPU mode: ~4–5 min. The NIfTI viewer renders the original scan while the model runs.
        </p>
      </div>

      <style>{`
        @keyframes shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}
