# Finds which files in OpenRocket's jar the design page reads as OpenRocket starts, in the order it
# reads them, and writes them to scripts/openrocket-startup.txt (scripts/slim-openrocket-jar.py puts
# them first in the jar). Rerun it after updating OpenRocket.
#
# CheerpJ reads a jar in 128 KB blocks, so the blocks it asks for do not tell which files it wanted.
# A "probe" copy of the jar gives each candidate file a block of its own (the gaps between are left
# empty, which zip readers allow): then every block read is one file. A read sometimes takes the next
# block too, so each design is opened twice, with the candidates in opposite orders, and only the
# files read both times count.
#
#   1. A normal run, for the candidates (the blocks start-up reads now), from web/:
#        PERF_RANGES=/tmp/so/normal.json node test/perf.mjs
#   2. The two probe jars:
#        python3 scripts/startup-order.py probe /tmp/so /tmp/so/normal.json
#   3. Each design with each probe ("new rocket" when PERF_EXAMPLE is not set), from web/:
#        PERF_JAR=/tmp/so/probe-fwd.jar PERF_RANGES=/tmp/so/new-fwd.json node test/perf.mjs
#        PERF_JAR=/tmp/so/probe-rev.jar PERF_RANGES=/tmp/so/new-rev.json node test/perf.mjs
#        PERF_EXAMPLE="Two stage high power rocket" PERF_JAR=/tmp/so/probe-fwd.jar PERF_RANGES=/tmp/so/two-fwd.json node test/perf.mjs
#        ... (and -rev, and more designs)
#   4. The list (the first design named sets the order; the others add what it did not read):
#        python3 scripts/startup-order.py order /tmp/so two new ...
#      then scripts/build-web-jars.sh.
import bisect, json, os, struct, sys, zipfile

BLOCK = 131072
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JAR = os.path.join(ROOT, 'web', 'public', 'or', 'OpenRocket-web.jar')
LIST = os.path.join(ROOT, 'scripts', 'openrocket-startup.txt')


def jar_ranges(run):
    """The byte ranges of OpenRocket-web.jar the page asked for in a run (test/perf.mjs PERF_RANGES)."""
    out = []
    for r in json.load(open(run)):
        if 'OpenRocket-web' in r['url'] and r.get('range') and r.get('where', 'page') == 'page':
            a, b = map(int, r['range'].split('=')[1].split('-'))
            out.append((r['start'], a, b))
    return sorted(out)


def probe(outdir, runs):
    data = open(JAR, 'rb').read()
    eocd = data.rfind(b'PK\x05\x06')
    cd_size, cd_off = struct.unpack('<II', data[eocd + 12:eocd + 20])
    infos = sorted(zipfile.ZipFile(JAR).infolist(), key=lambda i: i.header_offset)
    starts = [i.header_offset for i in infos] + [cd_off]
    spans = [(a, b) for run in runs for _, a, b in jar_ranges(run)]
    cand = [k for k in range(len(infos)) if any(a < starts[k + 1] and b >= starts[k] for a, b in spans)]
    rest = [k for k in range(len(infos)) if k not in set(cand)]
    for name, order in (('fwd', cand), ('rev', cand[::-1])):
        dst = os.path.join(outdir, f'probe-{name}.jar')
        newoff, slots, pos = {}, [], 0
        with open(dst, 'wb') as out:
            for k in order + rest:
                rec = data[starts[k]:starts[k + 1]]
                spread = k in set(cand)
                if spread:
                    pos = (pos + BLOCK - 1) // BLOCK * BLOCK
                out.seek(pos)
                out.write(rec)
                newoff[infos[k].header_offset] = pos
                slots.append([pos, pos + len(rec), infos[k].filename, spread])
                pos += len(rec)
            cd = bytearray(data[cd_off:cd_off + cd_size])
            p = 0
            while p < len(cd):
                nl, el, cl = struct.unpack('<HHH', cd[p + 28:p + 34])
                (old,) = struct.unpack('<I', cd[p + 42:p + 46])
                cd[p + 42:p + 46] = struct.pack('<I', newoff[old])
                p += 46 + nl + el + cl
            tail = bytearray(data[eocd:])
            tail[16:20] = struct.pack('<I', pos)
            out.write(cd)
            out.write(tail)
        if pos >= 2 ** 31:
            sys.exit('probe jar over 2 GB: CheerpJ cannot read it')
        json.dump(slots, open(dst + '.slots.json', 'w'))
        print(f'{dst}: {len(cand)} of {len(infos)} files in blocks of their own, {pos / 1e9:.2f} GB')


def files_read(run, slotsfile):
    """Files a run read, with the time of the first read."""
    slots = json.load(open(slotsfile))
    starts = [s[0] for s in slots]
    first = {}
    for t, a, b in jar_ranges(run):
        k = max(bisect.bisect_right(starts, a) - 1, 0)
        while k < len(slots) and slots[k][0] <= b:
            if slots[k][1] > a and slots[k][3]:
                first.setdefault(slots[k][2], t)
            k += 1
    return first


def order(outdir, designs):
    names, seen = [], set()
    for d in designs:
        fwd = files_read(os.path.join(outdir, f'{d}-fwd.json'), os.path.join(outdir, 'probe-fwd.jar.slots.json'))
        rev = files_read(os.path.join(outdir, f'{d}-rev.json'), os.path.join(outdir, 'probe-rev.jar.slots.json'))
        both = {n: fwd[n] for n in set(fwd) & set(rev)}
        new = [n for n in sorted(both, key=both.get) if n not in seen]
        names += new
        seen.update(new)
        print(f'{d}: {len(both)} files read, {len(new)} not read by the designs before it')
    head = [l for l in open(LIST, encoding='utf8') if l.startswith('#')]
    with open(LIST, 'w', encoding='utf8') as f:
        f.writelines(head)
        f.write('\n'.join(names) + '\n')
    sizes = {i.filename: i.compress_size for i in zipfile.ZipFile(JAR).infolist()}
    print(f'{LIST}: {len(names)} files, {sum(sizes.get(n, 0) for n in names) / 1e6:.2f} MB')


if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[1] == 'probe':
        probe(sys.argv[2], sys.argv[3:])
    elif len(sys.argv) >= 4 and sys.argv[1] == 'order':
        order(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(__doc__ if __doc__ else 'usage: startup-order.py probe <dir> <runs...> | order <dir> <designs...>')
