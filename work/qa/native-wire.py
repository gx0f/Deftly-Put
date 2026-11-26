import base64, hashlib, io, json, pathlib, struct, tempfile, unittest
from unittest.mock import patch
import sys
ROOT = pathlib.Path('Deftly-Put')
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT.joinpath('helper').resolve()))
import native_host as nh

class WireTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work/qa')
        self.data = pathlib.Path(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def test_manifest_key_derives_expected_native_origin(self):
        mf = json.loads(ROOT.joinpath('extension','manifest.json').read_text())
        digest = hashlib.sha256(base64.b64decode(mf['key'])).hexdigest()[:32]
        addon = ''.join(chr(97+int(x,16)) for x in digest)
        self.assertEqual(nh.EXTENSION_ORIGIN, 'chrome-extension://'+addon+'/')
    def test_message_codec(self):
        sample = {'action':'translate','draft':'给小灯罩上色。','post':'⛔','tone':'natural','target':'auto'}
        stream = io.BytesIO()
        nh.write_frame(stream,sample)
        self.assertEqual(nh.read_frame(io.BytesIO(stream.getvalue())),sample)
        raw=stream.getvalue()
        self.assertEqual(struct.unpack('=I',raw[:4])[0],len(raw[4:]))
    def test_wire_validation(self):
        vals=[b'\x01',struct.pack('=I',10)+b'{}',struct.pack('=I',0),struct.pack('=I',nh.MAX_FRAME+1)]
        for data in ([b'[]', b'\x80', b'junk']):
            vals.append(struct.pack('=I',len(data))+data)
        for raw in vals:
            with self.subTest(raw=raw):
                with self.assertRaises(nh.HostError): nh.read_frame(io.BytesIO(raw))
    def test_status_without_existing_profile(self):
        self.assertFalse(nh.dispatch({'action':'status'},self.data)['signedIn'])
    def test_draft_missing_and_context_validation(self):
        for msg, expected in [
            ({'draft':'','post':'word'},'EMPTY_DRAFT'),
            ({'draft':'\n  ','post':'word'},'EMPTY_DRAFT'),
            ({'draft':'hi','post':'\n'},'NO_CONTEXT'),
            ({'draft':3,'post':'abc'},'INVALID_REQUEST'),
            ({'draft':'abc','target':'<bad>'},'INVALID_REQUEST'),
            ({'draft':'abc','target':'en','source':'und'},'INVALID_REQUEST'),
            ({'draft':'abc','target':'en','source':'bad input'},'INVALID_REQUEST'),
            ({'draft':'abc','target':'ja','tone':'mystery'},'INVALID_REQUEST'),
            ({'draft':'abc','post':'x'*35001},'INVALID_REQUEST'),
            ({'draft':'abc','target':'ja'},'SIGNED_OUT')]:
            with self.subTest(expected=expected):
                with self.assertRaises(nh.HostError) as check:
                    nh.dispatch(dict(msg,action='translate'),self.data)
                self.assertEqual(nh.error_reply(check.exception)['code'],expected)
    def test_identity_only_requires_separate_plan_permission(self):
        with patch.object(nh,'Client') as typ:
            typ.return_value.status.return_value={'signedIn':True,'connected':False}
            with self.assertRaises(nh.HostError) as err:
                nh.dispatch({'action':'translate','draft':'纸船','post':'help'},self.data)
            typ.return_value.translate.assert_not_called()
            self.assertNotEqual(err.exception.code,'INVALID_REQUEST')
    def test_happy_path_payload(self):
        with patch.object(nh,'Client') as typ:
            typ.return_value.status.return_value={'signedIn':True,'connected':True}
            typ.return_value.translate.return_value={'translation':'翼を塗りましょう。','language':'ja'}
            x=nh.dispatch({'action':'translate','draft':'给机翼上色。','post':'模型','langHint':'ja','target':'auto','tone':'friendly'},self.data)
            self.assertEqual(x,{'ok':True,'text':'翼を塗りましょう。','language':'ja'})
            typ.return_value.translate.assert_called_once_with('模型','给机翼上色。','auto','friendly',lang_hint='ja')
    def test_standalone_post_preserves_configured_language_for_back_translation(self):
        with patch.object(nh.Client, 'status', return_value={'connected':True}), \
             patch.object(nh.Client, '_translation_request') as request:
            request.return_value = {'language':'en', 'translation':'The round lamp is on.', 'source_language':'zh-Hans'}
            result = nh.dispatch({'action':'translate', 'draft':'圓燈亮起。', 'source':'zh-Hant-TW',
                                  'target':'en'}, self.data)
            instructions, data, target = request.call_args.args
            self.assertIn('standalone X post', instructions)
            self.assertIn('source language (BCP 47): zh-Hant-TW', instructions)
            self.assertEqual((data['original_post'], target), ('', 'en'))
            self.assertEqual(result['sourceLanguage'], 'zh-Hant-TW')
            request.return_value = {'language':'zh-Hant-TW', 'translation':'圓燈亮起。'}
            checked = nh.dispatch({'action':'backTranslate', 'target':result['sourceLanguage'],
                                   'text':result['text']}, self.data)
            self.assertEqual(checked['text'], '圓燈亮起。')
            self.assertEqual(request.call_args.args[1:], ({'text':'The round lamp is on.'}, 'zh-Hant-TW'))
    def test_reply_without_source_still_detects_composing_language(self):
        with patch.object(nh.Client, 'status', return_value={'connected':True}), \
             patch.object(nh.Client, '_translation_request', return_value={
                 'language':'en', 'translation':'Yes!', 'source_language':'it'}) as request:
            result = nh.dispatch({'action':'translate', 'draft':'Sì!', 'post':'Coming?'}, self.data)
            instructions, _, target = request.call_args.args
            self.assertIn('ready-to-post reply', instructions)
            self.assertIn('"source_language"', instructions)
            self.assertEqual((target, result['sourceLanguage']), ('auto', 'it'))
if __name__=='__main__': unittest.main(verbosity=2)
