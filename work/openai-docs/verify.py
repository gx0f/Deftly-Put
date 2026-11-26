import base64, hashlib, io, json, os, secrets, stat, subprocess as sp, sys, tempfile, time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path('Deftly-Put/helper').resolve()))
import openai_plan as op
from openai_plan import PlanError
def one(p):return op.b64url(json.dumps(p).encode())
def red(fn):
    try: fn()
    except PlanError: return
    raise AssertionError("rejected input was accepted")

with tempfile.TemporaryDirectory() as tmp:
    tmp=Path(tmp); private=tmp/'signing.pem'
    sp.run(['/usr/bin/openssl','genrsa','-out',str(private),'2048'],check=True,stderr=sp.DEVNULL)
    modulus=sp.check_output(['/usr/bin/openssl','rsa','-in',str(private),'-noout','-modulus'],stderr=sp.DEVNULL).decode().split('=')[1].strip()
    jwks={'keys':[{'kty':'RSA','use':'sig','kid':'test','alg':'RS256','n':op.b64url(bytes.fromhex(modulus)),'e':op.b64url((65537).to_bytes(3,'big'))}]}
    def signed(claims,header=None):
        if header is None: header={'alg':'RS256','kid':'test'}
        signable=one(header)+'.'+one(claims)
        sig=sp.check_output(['/usr/bin/openssl','dgst','-sha256','-sign',str(private)],input=signable.encode())
        return signable+'.'+op.b64url(sig)
    root=tmp/'state'
    c=op.Client(root,"http://127.0.0.1:12345/auth/callback")
    oauth=parse_qs(urlsplit(c.begin_login()).query)
    assert oauth['client_id']==['dynamic_agent_client']
    assert oauth['code_challenge'][0]==op.b64url(hashlib.sha256(c.pending['verifier'].encode()).digest())
    claims={'iss':op.ISSUER,'sub':'example','aud':'oaiapp_test','nonce':oauth['nonce'][0],
            'exp':int(time.time())+1200,'email':'fixture@example.invalid'}
    jwt=signed(claims)
    grant={'token_type':'Bearer','scope':op.SCOPES,'access_token':'test-access','refresh_token':'test-refresh','id_token':jwt,'expires_in':3600}
    catalog={'models':[{'slug':'notshown','visibility':'hide'},{'slug':'test-model','visibility':'list'}]}
    def sources(url,**kwargs):
        if url.endswith('jwks.json'):return jwks
        assert url==op.API+'/models'
        return catalog
    def exchange(fields):
        assert fields['client_id']=='oaiapp_test' and fields['resource']==op.API
        if fields['grant_type']=='authorization_code':
            assert fields['redirect_uri']==c.redirect_uri and 'code_verifier' in fields
            return grant
        assert fields['refresh_token']=='test-refresh'
        return dict(grant,refresh_token='rotated')
    params={'state':oauth['state'][0],'client_id':'oaiapp_test','code':'test-code'}
    with patch.object(op,'get_json',side_effect=sources),patch.object(op,'form_token',side_effect=exchange):
        for new in ({'iss':'bad'},{'sub':''},{'aud':'other'},{'exp':0},{'nonce':'bad'},{'azp':'other'}):
            red(lambda:op.validated_identity(signed(dict(claims,**new)),params['client_id'],oauth['nonce'][0]))
        red(lambda:op.validated_identity(signed(claims,{'alg':'none','kid':'test'}),params['client_id'],oauth['nonce'][0]))
        head,body,sig=jwt.split('.')
        raw=bytearray(op.b64decode(sig));raw[-1]^=5
        red(lambda:op.validated_identity(head+'.'+body+'.'+op.b64url(raw),params['client_id'],oauth['nonce'][0]))
        red(lambda:c.finish_login(dict(params,state='other')))
        c.finish_login(params)
        assert c.status()=={'signedIn':True,'connected':True,'account':'fixture@example.invalid'}
        assert stat.S_IMODE((root/'openai-plan.json').stat().st_mode)==0o600
        red(lambda:c.finish_login(params))
        with c.store.locked() as state:
            a=state['accounts'][state['active']]
            a['expiry']=0; c.store.save(state)
        assert c.credentials()==('test-access','test-model')
        with c.store.locked() as state:assert state['accounts'][state['active']]['refresh_token']=='rotated'
        @contextmanager
        def stream(url,**kw):
            if url.endswith('/revoke'):
                assert b'rotated' in kw['body']
                yield io.BytesIO()
                return
            assert url==op.API+'/responses' and kw['bearer']=='test-access'
            body=json.loads(kw['body']);assert body['store'] is False and body['stream'] is True
            assert json.loads(body['input'][0]['content'])['draft']=='给气球涂上蓝色。'
            events=[{'type':'response.output_text.delta','delta':'{"language":"en",'},
                    {'type':'response.output_text.delta','delta':'"translation":"Paint the balloon blue."}'},
                    {'type':'response.completed'}]
            yield io.BytesIO(b''.join(b'event: status\ndata: '+json.dumps(e).encode()+b'\n\n' for e in events))
        with patch.object(op,'request',side_effect=stream):
            assert c.translate('The balloon needs a color.','给气球涂上蓝色。')=={'language':'en','translation':'Paint the balloon blue.'}
            red(lambda:c.translate('The balloon needs a color.','给气球涂上蓝色。','ja'))
            assert c.logout() and not c.status()['signedIn']
            assert parse_qs(urlsplit(c.begin_login()).query)['client_id']==['oaiapp_test']
            assert parse_qs(urlsplit(c.begin_login(new_account=True)).query)['client_id']==['dynamic_agent_client']
red(lambda:op.stream_text(io.BytesIO(b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n')))
red(lambda:op.translation_result('{"language":"und","translation":""}'))
red(lambda:op.translation_result('{"language":"zh-Hans","translation":"好"}','zh-Hant'))
print('PKCE, dynamic and returning client IDs, JWT RS256/issuer/audience/nonce/expiry/azp rejection, atomic file mode, rotation, request structure, SSE deltas and completion, language enforcement, logout: PASS.')
