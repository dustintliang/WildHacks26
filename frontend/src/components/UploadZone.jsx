import { useRef, useState } from 'react'

const ACCEPTED = ['.nii', '.nii.gz']

export default function UploadZone({ onSubmit, error }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState(null)

  const accept = (file) => {
    if (!file) return
    const name = file.name.toLowerCase()
    const valid = name.endsWith('.nii') || name.endsWith('.nii.gz')
    if (!valid) {
      alert('Please select a NIfTI file (.nii or .nii.gz)')
      return
    }
    setSelected(file)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    accept(e.dataTransfer.files[0])
  }

  const onDragOver = (e) => {
    e.preventDefault()
    setDragging(true)
  }

  const onDragLeave = () => setDragging(false)

  const handleSubmit = () => {
    if (selected) onSubmit(selected)
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-4">
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold mb-2">Upload Brain Scan</h2>
        <p className="text-gray-400 text-sm">
          Upload a NIfTI MRI scan and our model will segment cerebrovascular lesions
          and provide an AI-powered analysis.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`
          w-full max-w-md h-56 rounded-2xl border-2 border-dashed cursor-pointer
          flex flex-col items-center justify-center gap-3 transition-colors duration-200
          ${dragging
            ? 'border-cyan-400 bg-cyan-950/30'
            : selected
            ? 'border-cyan-600 bg-gray-900'
            : 'border-gray-700 bg-gray-900 hover:border-gray-500'
          }
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".nii,.nii.gz"
          className="hidden"
          onChange={(e) => accept(e.target.files[0])}
        />

        {selected ? (
          <>
            <div className="w-12 h-12 rounded-full bg-cyan-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-cyan-300">{selected.name}</p>
            <p className="text-xs text-gray-500">{(selected.size / 1024 / 1024).toFixed(1)} MB</p>
            <p className="text-xs text-gray-600">Click to change file</p>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <p className="text-sm text-gray-300">
              {dragging ? 'Drop to upload' : 'Drag & drop or click to browse'}
            </p>
            <p className="text-xs text-gray-600">Supports .nii and .nii.gz</p>
          </>
        )}
      </div>

      {error && (
        <div className="w-full max-w-md px-4 py-3 rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 w-full max-w-md items-center">
        <button
          onClick={handleSubmit}
          disabled={!selected}
          className={`
            w-full px-8 py-3 rounded-xl font-semibold text-sm transition-all duration-200
            ${selected
              ? 'bg-cyan-500 text-black hover:bg-cyan-400 active:scale-95'
              : 'bg-gray-800 text-gray-600 cursor-not-allowed'
            }
          `}
        >
          Analyze Scan
        </button>
        <button
          onClick={() => onSubmit(null, true)}
          className="w-full px-8 py-3 rounded-xl font-semibold text-sm transition-all duration-200 bg-indigo-600 text-white hover:bg-indigo-500 active:scale-95 border border-indigo-500/50 flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Run Demo (1.nii Dataset)
        </button>
      </div>

      <div className="flex gap-8 text-center">
        {[
          { label: 'Segmentation', desc: 'U-Net model' },
          { label: 'Analysis', desc: 'Gemini AI' },
          { label: 'Visualization', desc: '3D NIfTI viewer' },
        ].map(({ label, desc }) => (
          <div key={label}>
            <p className="text-xs font-medium text-gray-300">{label}</p>
            <p className="text-xs text-gray-600">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
