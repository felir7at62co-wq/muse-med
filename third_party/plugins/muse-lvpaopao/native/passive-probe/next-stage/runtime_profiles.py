"""Exact observed executable/DLL pairs and their qualified launch adapters."""
PROFILES = {'wmpf-25560': {'expectedAppId': 'wx404dde55fb12df78', 'executableSHA256': 'cea46b7485ff64dbd802da32811318a8844e55ce6cb3bb49325f31ebdb50f0ae', 'moduleSHA256': '60630cc1ba346b0e485fbf1981a07a650d1566e004c5b2b84933544860e2b3cf', 'loadStartRva': 47086832, 'expectedEntryBytes': '415741565657534881ec9001000089d34889ce833d469bf00a020f8ff9010000', 'cdpFilterRva': 60262864, 'expectedFilterEntryBytes': '5657534881ec900000004889ce488b05dc57110a4831e048898424880000000f', 'maxCallbacks': 4096, 'expectedScenes': [1183, 1256], 'allowDefaultIdentityRead': True, 'postUpgradeAuthorization': True, 'downloadEnabled': True}, 'wmpf-25799': {'expectedAppId': 'wx404dde55fb12df78', 'executableSHA256': '13251a0787f88f1bfdf48c7a636973b0620575df7aa41b131ddf78c3d6089bea', 'moduleSHA256': '84e424891cb9124065a60d1fd89e9bf320cd86d7cca3f409d347bedfb8befab9', 'loadStartRva': 47555136, 'expectedEntryBytes': '415741565657534881ec9001000089d34889ce833d3619f70a020f8ffd010000', 'cdpFilterRva': 59105744, 'expectedFilterEntryBytes': '4157415641554154565755534881ecb8020000440f298424a00200000f29bc24', 'maxCallbacks': 4096, 'expectedScenes': [1023, 1183, 1256], 'allowDefaultIdentityRead': True, 'postUpgradeAuthorization': True, 'downloadEnabled': True}}


def select_profile(config):
    """Resolve the adapter only when all pinned build fields match its profile."""
    name=config.get('runtimeProfile','wmpf-25560')
    if not isinstance(name,str) or name not in PROFILES:
        raise ValueError('runtime-profile-unsupported')
    profile=PROFILES[name]
    for key in ('expectedAppId','executableSHA256','moduleSHA256','loadStartRva','expectedEntryBytes','cdpFilterRva','expectedFilterEntryBytes'):
        if config.get(key)!=profile[key]:
            raise ValueError('runtime-profile-mismatch')
    if name=='wmpf-25799':
        return 'enable-target-debug-25799.js',dict(exceptor='off',unwind_broker=False,exit_monitor=False,thread_suspend_monitor=False)
    return 'enable-target-debug.js',{}
