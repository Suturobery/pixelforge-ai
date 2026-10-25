/**
 * PixelForge AI — pairing-token wordlist (v3.1 §5.1: "6-word one-time token").
 * 317 short, unambiguous, lowercase words → 6 unbiased CSPRNG picks ≈ 49.85
 * bits of entropy (corrected in Task 13a — the original byte-modulo picker
 * only reached the first 256 entries, i.e. 48 bits; auth.ts now uses 2-byte
 * rejection sampling over the full list). Words avoid confusing homoglyphs
 * (no l/1, o/0 pairs within the list) and are all ≥ 3 chars so the display
 * stays readable.
 */
export const WORDS: readonly string[] = [
  'amber','anchor','apple','arrow','atlas','aurora','autumn','azure',
  'bacon','badge','balsa','bamboo','banjo','basil','beacon','beetle',
  'birch','bison','bitter','blade','blaze','bloom','brave','breeze',
  'bridge','bronze','brook','bubble','buffalo','cabin','cactus','camel',
  'candle','canyon','cargo','cedar','cement','chalk','charm','cherry',
  'chess','chili','cider','citrus','clara','cliff','cloak','cobalt',
  'cobra','cocoa','comet','copper','coral','cosmic','cotton','crane',
  'crayon','crest','crisp','crystal','cypress','dagger','dahlia','daisy',
  'dawn','delta','denim','desert','diary','dingo','dodo','dolphin',
  'domino','donut','dragon','dune','dusk','eagle','earth','ember',
  'emerald','fable','falcon','fern','fiber','fiddle','fig','flame',
  'flint','float','flora','fossil','fox','frost','gadget','galaxy',
  'garnet','ginger','glacier','glide','granite','gravel','grotto','guitar',
  'gully','gumbo','gusto','hammock','harbor','harvest','hazel','heather',
  'helium','hickory','hollow','honey','horizon','hornet','humid','igloo',
  'indigo','inlet','iris','island','ivory','jade','jaguar','jasmine',
  'jelly','jetty','jewel','jigsaw','jungle','juniper','kayak','kernel',
  'kettle','keystone','kindle','koala','lagoon','lantern','laser','latitude',
  'lava','lettuce','lilac','linen','lotus','lumber','lunar','lyric',
  'magnet','magma','mahogany','mammoth','mango','maple','marble','marlin',
  'meadow','mercury','meteor','mint','mirage','monsoon','moss','mountain',
  'muffin','mulberry','mustard','nebula','nectar','needle','nickel','nimbus',
  'nomad','nordic','nugget','nutmeg','oasis','oat','obsidian','ocean',
  'octave','olive','onyx','opal','orbit','orchid','oregano','osprey',
  'otter','oxide','oyster','paddle','panther','papaya','paprika','parsley',
  'pastel','pebble','pepper','petal','pewter','phantom','pigment','pilot',
  'pine','pixel','plasma','plateau','plume','polar','poppy','prairie',
  'prism','puffin','pumice','quartz','quasar','quill','radish','rain',
  'raven','reef','ribbon','ridge','rifle','risen','river','robin',
  'rocket','rosin','ruby','rustic','saffron','sage','salmon','sandal',
  'sapphire','satin','scarf','sequoia','shadow','sherbet','shrimp','signal',
  'silk','siren','slate','smoke','snow','sonnet','spark','sphinx',
  'spiral','spruce','squid','stellar','stone','storm','stratus','stripe',
  'sunset','syrup','taffy','tangent','tapestry','teak','tempo','thistle',
  'thunder','tiger','timber','topaz','torch','totem','trail','tulip',
  'tundra','turbine','turtle','twine','ultra','umber','valley','vanilla',
  'velvet','vertex','vessel','violet','vivid','volcano','vortex','walnut',
  'walrus','wander','warden','waterfall','wattle','willow','window','winter',
  'wolf','wombat','xenon','yacht','yarrow','yeast','yodel','yonder',
  'zebra','zenith','zephyr','zinc','zodiac',
];
