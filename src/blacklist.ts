/** Upload and proxying blacklists. In the future this will live on-chain. */

interface Blacklist<T> {
    includes: (item: T) => boolean
}

export const imageBlacklist: Blacklist<string> = [
    'https://pbs.twimg.com/media/CoN_sC6XEAE7VOB.jpg:large',
    'https://ipfs.pics/ipfs/QmXz6jNVkH2FyMEUtXSAvbPN4EwG1uQJzDBq7gQCJs1Nym',
    'http://customerceobook.com/wp-content/uploads/2012/12/noahpozner420peoplemagazine.jpg',
    'http://reseauinternational.net/wp-content/uploads/2015/01/Sans-titre.jpg',
    'http://edge.liveleak.com/80281E/ll_a_u/thumbs/2015/Jan/1/67f252081582_sf_3.jpg',
    'http://st-listas.20minutos.es/images/2016-03/408680/list_640px.jpg?1458217580',
    'http://i1272.photobucket.com/albums/y391/mtgmtg_2012/mtgmtg_2012006/8575314572_bb657293cd_b_zps4d684b87.jpg',
    'http://img09.deviantart.net/c561/i/2015/005/4/b/psychedeliczen_id_by_psychedeliczen-d63npyv.jpg',
]

export const accountBlacklist: Blacklist<string> = [
    'aplomb',
    'iamgod',
]
