import { useState } from 'react'
import Header from './components/Header'
import UploadZone from './components/UploadZone'
import NiftiViewer from './components/NiftiViewer'
import AnalysisPanel from './components/AnalysisPanel'

const API_BASE = 'http://localhost:8000'

const LOADING_STEPS = [
  { label: 'Uploading scan', desc: 'Sending file to server...' },
  { label: 'Segmentation model', desc: 'Detecting cerebrovascular lesions...' },
  { label: 'Gemini analysis', desc: 'Generating AI interpretation...' },
  { label: 'Preparing results', desc: 'Almost done...' },
]

export default function App() {
  const [phase, setPhase] = useState('upload')
  const [originalFile, setOriginalFile] = useState(null)
  const [maskedBlob, setMaskedBlob] = useState(null)
  const [analysis, setAnalysis] = useState('')
  const [error, setError] = useState(null)
  const [loadingStep, setLoadingStep] = useState(0)

  const handleSubmit = async (file, isDemo = false) => {
    setError(null)
    setOriginalFile(file)
    setMaskedBlob(null)
    setAnalysis('')
    setLoadingStep(0)

    setPhase('processing')

    try {
      let res;
      setLoadingStep(1)
      
      if (isDemo) {
        res = await fetch(`${API_BASE}/analyze/demo`, {
          method: 'POST',
        })
      } else {
        const formData = new FormData()
        formData.append('file', file)
        res = await fetch(`${API_BASE}/analyze`, {
          method: 'POST',
          body: formData,
        })
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Server returned ${res.status}`)
      }

      // Received 202 {"job_id": "..."}
      const initialData = await res.json()
      const jobId = initialData.job_id
      
      setLoadingStep(2)
      
      // Poll until complete
      let data;
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3s
        const pollRes = await fetch(`${API_BASE}/results/${jobId}`)
        if (!pollRes.ok) throw new Error(`Polling failed: ${pollRes.status}`)
        data = await pollRes.json()
        
        if (data.status === 'complete' || data.status === 'failed') break;
        // if processing, continue
      }
      
      if (data.status === 'failed') {
         throw new Error(data.message || 'Pipeline failed during processing')
      }

      let blob = null
      // Download the vessel mask
      if (data.output_mask_path) {
         // the path is absolute on the server, but we serve the /output directory
         // so we extract the filename:
         const filename = data.output_mask_path.split(/[\/\\]/).pop();
         const r = await fetch(`${API_BASE}/output/${filename}`);
         if (!r.ok) throw new Error('Failed to fetch the resulting vessel mask');
         blob = await r.blob();
      }

      setLoadingStep(3)
      setMaskedBlob(blob)
      
      const narrative = data?.gemini_report?.narrative_summary || "No AI narrative generated.";
      setAnalysis(narrative)
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
    setAnalysis('')
    setError(null)
    setLoadingStep(0)
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
            {/* Left: NIFTI viewer — shows original scan immediately, mask overlaid when ready */}
            <div className="flex-[3] min-w-0">
              <NiftiViewer originalFile={originalFile} maskedBlob={maskedBlob} />
            </div>

            {/* Right: loading panel while processing, analysis panel when done */}
            <div className="flex-[2] min-w-0 border-l border-gray-800 overflow-y-auto">
              {phase === 'processing' ? (
                <ProcessingPanel step={loadingStep} steps={LOADING_STEPS} />
              ) : (
                <AnalysisPanel analysis={analysis} onReset={reset} />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function ProcessingPanel({ step, steps }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold">Processing Scan</h2>
        <p className="text-xs text-gray-500 mt-0.5">Segmentation model running...</p>
      </div>

      <div className="flex-1 px-5 py-6 space-y-3">
        {steps.map((s, i) => {
          const done = i < step
          const active = i === step
          return (
            <div
              key={i}
              className={`flex items-start gap-3 px-4 py-3 rounded-xl border transition-colors ${
                active
                  ? 'border-cyan-700 bg-cyan-950/30'
                  : done
                  ? 'border-gray-700 bg-gray-900/40'
                  : 'border-gray-800 bg-transparent'
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {done ? (
                  <div className="w-5 h-5 rounded-full bg-cyan-500 flex items-center justify-center">
                    <svg className="w-3 h-3 text-black" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                ) : active ? (
                  <div className="w-5 h-5 rounded-full border-2 border-t-cyan-400 border-gray-600 animate-spin" />
                ) : (
                  <div className="w-5 h-5 rounded-full border-2 border-gray-700" />
                )}
              </div>
              <div>
                <p className={`text-sm font-medium ${active ? 'text-white' : done ? 'text-gray-400' : 'text-gray-600'}`}>
                  {s.label}
                </p>
                {active && (
                  <p className="text-xs text-gray-500 mt-0.5">{s.desc}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        <p className="text-xs text-gray-600 leading-relaxed">
          The original scan is rendering in the viewer. The lesion mask will appear as an overlay once segmentation completes.
        </p>
      </div>
    </div>
  )
}
