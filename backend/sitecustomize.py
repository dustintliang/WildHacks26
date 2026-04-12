"""Runtime compatibility shims for legacy neuroimaging dependencies."""

import numpy as np


# Older dependencies bundled with eICAB still reference deprecated NumPy
# aliases removed in NumPy 1.24+. Restore the small subset they rely on.
if not hasattr(np, "float"):
    np.float = float  # type: ignore[attr-defined]

if not hasattr(np, "int"):
    np.int = int  # type: ignore[attr-defined]

if not hasattr(np, "bool"):
    np.bool = bool  # type: ignore[attr-defined]
