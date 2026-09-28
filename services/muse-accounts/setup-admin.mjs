import {openStore} from './store.mjs';
// Run before starting the gateway. Password is read from stdin, never argv or logs.
try{
 let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>1024)throw Error('Input too large');chunks.push(chunk);}const secret=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
 const store=await openStore(process.env.MUSE_ACCOUNTS_FILE||'/var/lib/muse/accounts.json');const username=process.argv[2]||'ylk';
 await store.create(username,secret,{admin:true});console.log('Administrator created.');
}catch{console.error('Administrator setup failed; check input and whether the account already exists.');process.exitCode=1;}
