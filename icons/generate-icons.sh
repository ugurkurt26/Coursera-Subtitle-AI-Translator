#!/bin/bash
# Generate PNG icons from SVG using ImageMagick (convert) or Inkscape.
# Run: bash icons/generate-icons.sh
#
# If you don't have these tools, create icon-16.png, icon-48.png, icon-128.png
# manually and place them in this directory.

SVG="icons/icon.svg"

if command -v convert &>/dev/null; then
  convert -background none -density 384 "$SVG" -resize 16x16   icons/icon-16.png
  convert -background none -density 384 "$SVG" -resize 48x48   icons/icon-48.png
  convert -background none -density 384 "$SVG" -resize 128x128 icons/icon-128.png
  echo "Icons generated with ImageMagick."
elif command -v inkscape &>/dev/null; then
  inkscape "$SVG" -w 16  -h 16  -o icons/icon-16.png
  inkscape "$SVG" -w 48  -h 48  -o icons/icon-48.png
  inkscape "$SVG" -w 128 -h 128 -o icons/icon-128.png
  echo "Icons generated with Inkscape."
else
  echo "Install ImageMagick or Inkscape to generate icons from SVG."
  exit 1
fi
