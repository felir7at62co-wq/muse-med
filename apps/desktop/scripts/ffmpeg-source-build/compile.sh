#!/usr/bin/env bash
# Compile only from mounted source and the pinned dependency image; Docker denies network.
set -euo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/source
cd /work/build
"$CC" --version > /work/evidence/compiler-version.txt
"$CC" -print-sysroot > /work/evidence/compiler-sysroot.txt
printf '%s\n' "$FFBUILD_TARGET_FLAGS" "$FF_CONFIGURE" > /work/evidence/configure-flags.txt
case " $FF_CONFIGURE " in
    *' --enable-nonfree '*) echo 'Nonfree builds cannot be packaged' >&2; exit 1 ;;
esac
# BtbN stores configure options as shell word lists, not executable shell input.
# shellcheck disable=SC2086
/source/configure --prefix=/work/runtime --pkg-config-flags=--static \
    $FFBUILD_TARGET_FLAGS $FF_CONFIGURE \
    --disable-autodetect --disable-ffplay --enable-gpl --enable-version3 \
    --extra-cflags="$FF_CFLAGS" --extra-cxxflags="$FF_CXXFLAGS" --extra-libs="$FF_LIBS" \
    --extra-ldflags="$FF_LDFLAGS" --extra-ldexeflags="$FF_LDEXEFLAGS" \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$NM" \
    --extra-version=muse-med
for required in CONFIG_LIBX264 CONFIG_LIBASS CONFIG_SUBTITLES_FILTER CONFIG_ASS_FILTER; do
    grep -qx "#define $required 1" config.h config_components.h || { echo "Missing $required" >&2; exit 1; }
done
make -j"${BUILD_JOBS:-2}" V=1
make install install-doc
