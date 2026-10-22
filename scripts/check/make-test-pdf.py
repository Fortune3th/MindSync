"""Generate a deterministic, readable PDF fixture with high-entropy image bytes.

Test tooling only; requires reportlab and Pillow, never application runtime.
"""
from pathlib import Path
import random
import sys
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

output = Path(sys.argv[1] if len(sys.argv) > 1 else "nas-data/dedup-fixture.pdf")
output.parent.mkdir(parents=True, exist_ok=True)
image = Image.frombytes("RGB", (1024, 700), random.Random(1337).randbytes(1024 * 700 * 3))
pdf = canvas.Canvas(str(output), pagesize=(612, 792), pageCompression=0, invariant=1)
pdf.setTitle("MindSync PDF deduplication acceptance fixture")
pdf.setFont("Helvetica", 16)
pdf.drawString(36, 750, "MindSync PDF deduplication acceptance fixture")
pdf.setFont("Helvetica", 10)
pdf.drawString(36, 725, "Deterministic synthetic image; no user documents or private data.")
pdf.drawImage(ImageReader(image), 36, 295, width=540, height=369)
pdf.drawString(36, 270, "Versions differ only in trailing PDF comments for the reuse test.")
pdf.save()
print(f"Generated PDF fixture: {output.stat().st_size} bytes")
