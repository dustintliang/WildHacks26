/**
 * Builds a labeled NIfTI-1 (.nii.gz) Blob from the mock analyze_response and
 * render_response JSON objects.  Each voxel in the output volume is set to the
 * artery label ID (1–11) defined in ARTERY_META; background voxels stay at 0.
 *
 * The returned Blob can be used as the maskedBlob prop of NiftiViewer with
 *   overlayMeta = { kind: 'artery_labels' }
 */

// Mirror of the ARTERY_META defined in NiftiViewer so we can map key → id
// without importing the component (avoids a circular dependency).
const ARTERY_ID_MAP = {
  left_ICA:        1,
  right_ICA:       2,
  left_MCA:        3,
  right_MCA:       4,
  left_ACA:        5,
  right_ACA:       6,
  left_PCA:        7,
  right_PCA:       8,
  basilar:         9,
  left_vertebral:  10,
  right_vertebral: 11,
}

/**
 * @param {object} analyzeData  – parsed analyze_response.json
 * @param {object} renderData   – parsed render_response.json
 * @returns {Promise<Blob>}     – gzip-compressed NIfTI-1 blob
 */
export async function buildLabeledNifti(analyzeData, renderData) {
  const { binary_segments } = analyzeData
  const { shape, affine, voxel_size } = renderData
  const [nx, ny, nz] = shape  // e.g. [512, 512, 100]

  // --- 1. Fill voxel data --------------------------------------------------
  const voxelData = new Uint8Array(nx * ny * nz)

  for (const [key, labelId] of Object.entries(ARTERY_ID_MAP)) {
    const seg = binary_segments[key]
    if (!seg?.visible || !seg.data?.length) continue
    for (const [x, y, z] of seg.data) {
      // NIfTI stores in column-major (x varies fastest): idx = x + nx*(y + ny*z)
      voxelData[x + nx * (y + ny * z)] = labelId
    }
  }

  // --- 2. Build 348-byte NIfTI-1 header + 4-byte extension -----------------
  const headerBuf = new ArrayBuffer(352)
  const v = new DataView(headerBuf)
  const le = true  // little-endian throughout

  // sizeof_hdr
  v.setInt32(0, 348, le)

  // dim[8]  (offset 40, int16[8])
  v.setInt16(40,  3,  le)   // ndim
  v.setInt16(42,  nx, le)
  v.setInt16(44,  ny, le)
  v.setInt16(46,  nz, le)
  v.setInt16(48,  1,  le)
  v.setInt16(50,  1,  le)
  v.setInt16(52,  1,  le)
  v.setInt16(54,  1,  le)

  // datatype = 2 (DT_UNSIGNED_CHAR / uint8), bitpix = 8
  v.setInt16(70, 2, le)
  v.setInt16(72, 8, le)

  // pixdim[8]  (offset 76, float32[8])
  v.setFloat32(76, 1.0,           le)  // qfac
  v.setFloat32(80, voxel_size[0], le)
  v.setFloat32(84, voxel_size[1], le)
  v.setFloat32(88, voxel_size[2], le)
  // remaining pixdims stay 0

  // vox_offset (header + extension = 352)
  v.setFloat32(108, 352.0, le)

  // scl_slope = 1, scl_inter = 0
  v.setFloat32(112, 1.0, le)
  v.setFloat32(116, 0.0, le)

  // xyzt_units = 2 (NIFTI_UNITS_MM)
  v.setUint8(123, 2)

  // cal_max = 11 (number of labels), cal_min = 0
  v.setFloat32(124, 11.0, le)
  v.setFloat32(128, 0.0,  le)

  // qform_code = 0 (unknown), sform_code = 1 (scanner)
  v.setInt16(252, 0, le)
  v.setInt16(254, 1, le)

  // srow_x/y/z from affine rows 0–2  (offset 280/296/312, float32[4] each)
  const [row0, row1, row2] = affine
  for (let c = 0; c < 4; c++) {
    v.setFloat32(280 + c * 4, row0[c], le)
    v.setFloat32(296 + c * 4, row1[c], le)
    v.setFloat32(312 + c * 4, row2[c], le)
  }

  // magic "n+1\0"
  v.setUint8(344, 0x6e)
  v.setUint8(345, 0x2b)
  v.setUint8(346, 0x31)
  v.setUint8(347, 0x00)
  // extension bytes 348–351 are already zero

  // --- 3. Concatenate header + voxel data ----------------------------------
  const raw = new Uint8Array(352 + voxelData.length)
  raw.set(new Uint8Array(headerBuf), 0)
  raw.set(voxelData, 352)

  // --- 4. gzip compress (Compression Streams API) --------------------------
  return gzip(raw)
}

async function gzip(data) {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  const reader = cs.readable.getReader()

  writer.write(data)
  writer.close()

  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  return new Blob(chunks, { type: 'application/octet-stream' })
}
