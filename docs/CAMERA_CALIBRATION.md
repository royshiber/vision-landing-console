# Camera calibration

Both CAM0 and CAM1 use the same guided checkerboard flow on the optics tab.

## Board

- Inner corners: 9 by 6 (10 by 7 squares).
- Square size: 25 mm. The field on the form is in millimetres and can be changed before start.
- Print `docs/calibration-board.pdf` at 100 percent scale. Do not use fit-to-page. The page is A4 landscape.

## Flow

1. Press התחל כיול.
2. Hold the board in view. The companion looks for the grid with OpenCV `findChessboardCorners` when OpenCV is installed, and with the offline grid finder otherwise.
3. A frame is kept only when the pose is new: closer or farther, a corner of the image, or a tilt. Repeats are skipped.
4. The form shows progress such as 12/20 and a short hint: קרב את הלוח, הרחק את הלוח, הטה את הלוח, or הזז לפינה.
5. At 20 views the companion solves intrinsics and distortion and shows the RMS reprojection error with a Hebrew verdict: מצוין, טוב, סביר, or חלש.
6. שמירה writes that result for the camera. שוב clears the views.

## Persistence

CAM0 is stored under the companion calibration directory (`latest.json`). CAM1 is stored under `cam1-calibration` on the same machine. A Jetson still on companion 2.6.4 must be redeployed before this session route exists.
