# Makes the browser copy of OpenRocket.jar: OpenRocket's own code is untouched; removed are parts a
# browser cannot use (native libraries, the GraalJS scripting engine and its ICU library, GraalVM
# native-image support, Photo Studio sky images) and service entries that point at removed classes.
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
DROP_PREFIXES = ('com/oracle/truffle/', 'com/oracle/js/', 'com/oracle/svm/', 'org/graalvm/', 'com/ibm/icu/',
                 'datafiles/sky/', 'natives/', 'org/eclipse/angus/activation/nativeimage/')
DROP_SUFFIXES = ('.so', '.dll', '.jnilib', '.dylib')
zin = zipfile.ZipFile(src)
names = set(zin.namelist())
def dropped(n):
    if n.startswith(DROP_PREFIXES) or n.lower().endswith(DROP_SUFFIXES): return True
    if n.startswith('META-INF/versions/') and n.split('/')[2].isdigit() and int(n.split('/')[2]) > 17: return True
    return False
kept = removed = 0
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
    for info in zin.infolist():
        n = info.filename
        if dropped(n):
            removed += 1
            continue
        data = zin.read(n)
        if n.startswith('META-INF/services/'):
            lines = data.decode('utf8').splitlines()
            keep = [l for l in lines if not l.strip() or l.strip().startswith('#')
                    or (l.strip().replace('.', '/') + '.class') in names and not dropped(l.strip().replace('.', '/') + '.class')]
            if not [l for l in keep if l.strip() and not l.strip().startswith('#')]:
                removed += 1
                continue
            data = ('\n'.join(keep) + '\n').encode('utf8')
        zi = zipfile.ZipInfo(n, date_time=info.date_time)
        zi.compress_type = zipfile.ZIP_STORED if info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
        zi.external_attr = info.external_attr
        zout.writestr(zi, data)
        kept += 1
print(f"kept {kept} entries, removed {removed}")
