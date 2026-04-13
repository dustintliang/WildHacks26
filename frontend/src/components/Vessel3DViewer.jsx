import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { ARTERY_META } from './NiftiViewer'

/**
 * 3D interactive vessel renderer using Three.js.
 * Renders the blood vessel voxel data from the analyze_response JSON
 * as a colored point-cloud / sphere-based visualization.
 *
 * Props:
 *   analyzeResponse – the full parsed analyze_response JSON
 */
export default function Vessel3DViewer({ analyzeResponse }) {
  const mountRef = useRef(null)
  const rendererRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const frameRef = useRef(null)
  const controlsRef = useRef(null)
  const meshGroupRef = useRef(null)

  const [hoveredArtery, setHoveredArtery] = useState(null)
  const [hiddenArteries, setHiddenArteries] = useState(new Set())
  const [renderMode, setRenderMode] = useState('points') // 'points' | 'surface'
  const [pointSize, setPointSize] = useState(2.5)
  const [autoRotate, setAutoRotate] = useState(true)

  const segments = analyzeResponse?.binary_segments ?? null

  const visibleArteries = ARTERY_META.filter(
    m => segments ? segments[m.key]?.visible : false
  )

  // ── Build scene ────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !segments) return

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070708)
    scene.fog = new THREE.FogExp2(0x070708, 0.003)
    sceneRef.current = scene

    // Camera
    const w = mount.clientWidth
    const h = mount.clientHeight
    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000)
    camera.position.set(0, 0, 350)
    cameraRef.current = camera

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(100, 200, 150)
    scene.add(dirLight)

    const dirLight2 = new THREE.DirectionalLight(0x8888ff, 0.3)
    dirLight2.position.set(-100, -50, -100)
    scene.add(dirLight2)

    // Simple orbit controls (manual implementation to avoid extra deps)
    const controls = createOrbitControls(camera, renderer.domElement)
    controlsRef.current = controls

    // Resize handler
    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frameRef.current)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [segments])

  // ── Build vessel geometry ─────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !segments) return

    // Remove old group
    if (meshGroupRef.current) {
      scene.remove(meshGroupRef.current)
      meshGroupRef.current.traverse(child => {
        if (child.geometry) child.geometry.dispose()
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
          else child.material.dispose()
        }
      })
    }

    const group = new THREE.Group()
    meshGroupRef.current = group

    // Compute centroid of all vessel voxels for centering
    let totalX = 0, totalY = 0, totalZ = 0, totalCount = 0
    for (const meta of ARTERY_META) {
      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue
      for (const [x, y, z] of seg.data) {
        totalX += x; totalY += y; totalZ += z
        totalCount++
      }
    }
    const cx = totalCount > 0 ? totalX / totalCount : 256
    const cy = totalCount > 0 ? totalY / totalCount : 256
    const cz = totalCount > 0 ? totalZ / totalCount : 50

    // Build geometry for each artery
    for (const meta of ARTERY_META) {
      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue
      if (hiddenArteries.has(meta.key)) continue

      const [r, g, b] = meta.rgb
      const color = new THREE.Color(r / 255, g / 255, b / 255)

      if (renderMode === 'points') {
        // Point cloud rendering (fast, works well with many voxels)
        const positions = new Float32Array(seg.data.length * 3)
        const colors = new Float32Array(seg.data.length * 3)

        for (let i = 0; i < seg.data.length; i++) {
          const [x, y, z] = seg.data[i]
          positions[i * 3]     = x - cx
          positions[i * 3 + 1] = z - cz
          positions[i * 3 + 2] = -(y - cy)
          colors[i * 3]     = color.r
          colors[i * 3 + 1] = color.g
          colors[i * 3 + 2] = color.b
        }

        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

        const material = new THREE.PointsMaterial({
          size: pointSize,
          vertexColors: true,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.9,
        })

        const points = new THREE.Points(geometry, material)
        points.userData = { arteryKey: meta.key, arteryName: meta.name }
        group.add(points)
      } else {
        // Surface rendering using merged spheres for centerline + point cloud for voxels
        // Use centerline for thicker tube-like appearance, voxels as supplementary cloud
        const centerline = seg.centerline || []

        if (centerline.length > 1) {
          // Build a tube along the centerline
          const curvePoints = centerline.map(
            ([x, y, z]) => new THREE.Vector3(x - cx, z - cz, -(y - cy))
          )
          const curve = new THREE.CatmullRomCurve3(curvePoints, false, 'catmullrom', 0.5)
          const tubeRadius = Math.max(0.8, (seg.mean_radius_mm || 1) * 3)
          const tubeGeom = new THREE.TubeGeometry(curve, Math.max(8, centerline.length * 2), tubeRadius, 8, false)
          const tubeMat = new THREE.MeshPhongMaterial({
            color,
            shininess: 60,
            transparent: true,
            opacity: 0.85,
          })
          const tubeMesh = new THREE.Mesh(tubeGeom, tubeMat)
          tubeMesh.userData = { arteryKey: meta.key, arteryName: meta.name }
          group.add(tubeMesh)
        }

        // Also add voxels as smaller points for volume
        const step = Math.max(1, Math.floor(seg.data.length / 2000))
        const sampled = seg.data.filter((_, i) => i % step === 0)
        const positions = new Float32Array(sampled.length * 3)
        const colorsArr = new Float32Array(sampled.length * 3)

        for (let i = 0; i < sampled.length; i++) {
          const [x, y, z] = sampled[i]
          positions[i * 3]     = x - cx
          positions[i * 3 + 1] = z - cz
          positions[i * 3 + 2] = -(y - cy)
          colorsArr[i * 3]     = color.r
          colorsArr[i * 3 + 1] = color.g
          colorsArr[i * 3 + 2] = color.b
        }

        const ptGeom = new THREE.BufferGeometry()
        ptGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        ptGeom.setAttribute('color', new THREE.BufferAttribute(colorsArr, 3))
        const ptMat = new THREE.PointsMaterial({
          size: pointSize * 0.6,
          vertexColors: true,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.4,
        })
        const ptMesh = new THREE.Points(ptGeom, ptMat)
        group.add(ptMesh)
      }
    }

    // Add a subtle grid helper (horizontal in Y-up space)
    const gridHelper = new THREE.GridHelper(400, 40, 0x222233, 0x111122)
    gridHelper.position.y = -50
    group.add(gridHelper)

    scene.add(group)
  }, [segments, hiddenArteries, renderMode, pointSize])

  // ── Auto-rotate ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  const toggleArtery = useCallback((key) => {
    setHiddenArteries(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  const rgbStr = ([r, g, b]) => `rgb(${r},${g},${b})`

  if (!segments) {
    return (
      <div className="flex items-center justify-center h-full bg-[#070708]">
        <p className="text-sm text-gray-600">No vessel data available.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#070708]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-900/90 border-b border-gray-800 shrink-0 backdrop-blur">
        {/* Render mode */}
        <div className="flex gap-1">
          <button
            onClick={() => setRenderMode('points')}
            className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
              renderMode === 'points'
                ? 'bg-indigo-400 text-black shadow-lg shadow-indigo-500/30'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            Points
          </button>
          <button
            onClick={() => setRenderMode('surface')}
            className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
              renderMode === 'surface'
                ? 'bg-indigo-400 text-black shadow-lg shadow-indigo-500/30'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            Tubes
          </button>
        </div>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        {/* Point size */}
        <label className="text-xs text-gray-500">Size:</label>
        <input
          type="range" min={0.5} max={6} step={0.25} value={pointSize}
          onChange={e => setPointSize(Number(e.target.value))}
          className="w-20 accent-indigo-400"
        />
        <span className="text-xs text-gray-500 w-6">{pointSize.toFixed(1)}</span>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        {/* Auto rotate */}
        <button
          onClick={() => setAutoRotate(!autoRotate)}
          className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
            autoRotate
              ? 'bg-purple-500/30 text-purple-300 border border-purple-500/40'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {autoRotate ? 'Rotating' : 'Static'}
        </button>

        <span className="ml-auto text-xs text-gray-600 hidden sm:block">
          Drag to rotate · Scroll to zoom · Right-drag to pan
        </span>
      </div>

      {/* Artery legend / toggle strip */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2
                      bg-gray-950/80 border-b border-gray-800 shrink-0 max-h-28 overflow-y-auto">
        <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide mr-1">
          Arteries
        </span>
        {ARTERY_META.map(meta => {
          const seg = segments[meta.key]
          if (!seg?.visible) return null
          const isHidden = hiddenArteries.has(meta.key)
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
                style={{
                  background: rgbStr(meta.rgb),
                  boxShadow: isHidden ? 'none' : `0 0 4px ${rgbStr(meta.rgb)}`,
                }}
              />
              {meta.name}
              {seg.voxel_count > 0 && (
                <span className="text-gray-600 text-[9px] ml-0.5">
                  {(seg.voxel_count / 1000).toFixed(1)}k
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 3D Canvas */}
      <div ref={mountRef} className="flex-1 min-h-0 relative">
        {/* Stats overlay */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
          <div className="px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm border border-white/5">
            <span className="text-[10px] text-gray-400">
              {visibleArteries.filter(m => !hiddenArteries.has(m.key)).length} arteries ·{' '}
              {visibleArteries
                .filter(m => !hiddenArteries.has(m.key))
                .reduce((sum, m) => sum + (segments[m.key]?.voxel_count || 0), 0)
                .toLocaleString()}{' '}
              voxels
            </span>
          </div>
        </div>

        {hoveredArtery && (
          <div
            className="absolute bottom-3 right-3 z-10 flex items-center gap-2
                       px-3 py-1.5 rounded-lg text-xs font-bold backdrop-blur-sm
                       border border-white/10 shadow-xl"
            style={{
              background: `rgba(${hoveredArtery.rgb.join(',')},0.2)`,
              color: rgbStr(hoveredArtery.rgb),
              borderColor: `rgba(${hoveredArtery.rgb.join(',')},0.4)`,
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: rgbStr(hoveredArtery.rgb),
                boxShadow: `0 0 6px ${rgbStr(hoveredArtery.rgb)}`,
              }}
            />
            {hoveredArtery.name}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Simple orbit controls ─────────────────────────────────────────────────
function createOrbitControls(camera, domElement) {
  let isDragging = false
  let isRightDrag = false
  let prevX = 0, prevY = 0
  let theta = 0, phi = Math.PI / 2
  let radius = camera.position.length()
  let target = new THREE.Vector3(0, 0, 0)
  let _autoRotate = true

  const onMouseDown = (e) => {
    isDragging = true
    isRightDrag = e.button === 2
    prevX = e.clientX
    prevY = e.clientY
  }

  const onMouseMove = (e) => {
    if (!isDragging) return
    const dx = e.clientX - prevX
    const dy = e.clientY - prevY
    prevX = e.clientX
    prevY = e.clientY

    if (isRightDrag) {
      // Pan
      const panSpeed = 0.5
      const right = new THREE.Vector3()
      const up = new THREE.Vector3()
      right.setFromMatrixColumn(camera.matrix, 0)
      up.setFromMatrixColumn(camera.matrix, 1)
      target.add(right.multiplyScalar(-dx * panSpeed))
      target.add(up.multiplyScalar(dy * panSpeed))
    } else {
      // Rotate
      theta -= dx * 0.005
      phi -= dy * 0.005
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi))
    }
  }

  const onMouseUp = () => {
    isDragging = false
    isRightDrag = false
  }

  const onWheel = (e) => {
    radius *= e.deltaY > 0 ? 1.08 : 0.92
    radius = Math.max(50, Math.min(1000, radius))
    e.preventDefault()
  }

  const onContextMenu = (e) => e.preventDefault()

  domElement.addEventListener('mousedown', onMouseDown)
  domElement.addEventListener('mousemove', onMouseMove)
  domElement.addEventListener('mouseup', onMouseUp)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  domElement.addEventListener('contextmenu', onContextMenu)

  // Touch support
  let lastTouchDist = 0
  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      isDragging = true
      prevX = e.touches[0].clientX
      prevY = e.touches[0].clientY
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      lastTouchDist = Math.sqrt(dx * dx + dy * dy)
    }
  }

  const onTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - prevX
      const dy = e.touches[0].clientY - prevY
      prevX = e.touches[0].clientX
      prevY = e.touches[0].clientY
      theta -= dx * 0.005
      phi -= dy * 0.005
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi))
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (lastTouchDist > 0) {
        radius *= lastTouchDist / dist
        radius = Math.max(50, Math.min(1000, radius))
      }
      lastTouchDist = dist
    }
  }

  const onTouchEnd = () => {
    isDragging = false
    lastTouchDist = 0
  }

  domElement.addEventListener('touchstart', onTouchStart, { passive: true })
  domElement.addEventListener('touchmove', onTouchMove, { passive: true })
  domElement.addEventListener('touchend', onTouchEnd)

  return {
    get autoRotate() { return _autoRotate },
    set autoRotate(v) { _autoRotate = v },
    update() {
      if (_autoRotate && !isDragging) {
        theta += 0.003
      }
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.sin(theta),
      )
      camera.lookAt(target)
    },
    dispose() {
      domElement.removeEventListener('mousedown', onMouseDown)
      domElement.removeEventListener('mousemove', onMouseMove)
      domElement.removeEventListener('mouseup', onMouseUp)
      domElement.removeEventListener('wheel', onWheel)
      domElement.removeEventListener('contextmenu', onContextMenu)
      domElement.removeEventListener('touchstart', onTouchStart)
      domElement.removeEventListener('touchmove', onTouchMove)
      domElement.removeEventListener('touchend', onTouchEnd)
    },
  }
}
