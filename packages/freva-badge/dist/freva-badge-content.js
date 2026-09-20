// Everything a copywriter or a maintainer needs to change, in one file, with no animation logic
// anywhere near it. Load this before freva-badge.js.
window.FrevaBadgeContent = {
  badgeTitle: 'About Freva',
  badgeEyebrow: 'POWERED BY',
  badgeName: 'Freva',
  dialogLabel: 'About Freva',
  closeTitle: 'Close',
  email: 'freva@dkrz.de',
  orgsLabel: 'In use at',
  orgsAria: 'Institutions and projects using Freva',

  // Two headline lines, one subline. Keep each headline line to about 17 characters at the
  // current size or the second line wraps and the block grows a row. `mark` is the word in cyan.
  copy: {
    kicker: 'Freva:',
    head: [
      { text: 'Find any dataset.' },
      { text: 'Prove any result.', mark: 'Prove' }
    ],
    sub: 'The free evaluation layer for climate model data.'
  },

  // The two cyan pieces of the mark. Point `href` wherever it should go.
  links: {
    docs: {
      href: 'https://freva-org.github.io/',
      aria: 'About Freva: what the project is and who runs it.',
      front: 'About us', backTitle: 'The project',
      backCopy: 'What Freva is,<br>who runs it', cta: 'Open&nbsp;↗'
    },
    api: {
      href: 'https://freva-org.github.io/freva-nextgen/developers/index.html',
      aria: 'Build your own client against the Freva REST API.',
      front: 'Build your<br>own client', backTitle: 'REST API',
      backCopy: 'Query from<br>your code', cta: 'Open&nbsp;↗'
    }
  },

  // Each chip is a mark, a name and a home. `logo` is resolved against `assetBase` unless it is
  // absolute; leave it empty and the slot stays a deliberate box rather than inventing a mark for
  // an institution that has its own. The marks in `assets/orgs/` are traced placeholders - see
  // ORG_LOGO_SOURCES.md before a public release.
  orgs: [
    { name: 'DKRZ',          logo: 'orgs/dkrz.svg',          href: 'https://dkrz.de' },
    { name: 'FU Berlin',     logo: 'orgs/fu-berlin.svg',     href: 'https://www.fu-berlin.de/' },
    { name: 'nextGEMS',      logo: 'orgs/nextgems.svg',      href: 'https://nextgems-h2020.eu/' },
    { name: 'RegIKlim',      logo: 'orgs/regiklim.svg',      href: 'https://www.fona.de/de/massnahmen/foerdermassnahmen/regionale-informationen-zum-klimahandeln.php' },
    { name: 'NUKLEUS',       logo: 'orgs/nukleus.svg',       href: 'https://www.climate-service-center.de/science/projects/detail/086703/index.php.de' },
    { name: 'ClimXtreme',    logo: 'orgs/climxtreme.svg',    href: 'https://www.climxtreme.de/' },
    { name: 'CODES',         logo: 'orgs/codes.svg',         href: 'https://www.comingdecade.uni-hamburg.de/' },
    { name: 'Klimakataster', logo: 'orgs/klimakataster.svg', href: 'https://klimakataster.dkrz.de/' },
    { name: 'ESGF',          logo: 'orgs/esgf.svg',          href: 'https://esgf.github.io/' },
    { name: 'JSC',           logo: 'orgs/jsc.svg',           href: 'https://www.fz-juelich.de/' },
    { name: 'NCAR',          logo: 'orgs/ncar.svg',          href: 'https://ncar.ucar.edu/' },
    { name: 'BSC',           logo: 'orgs/bsc.svg',           href: 'https://www.bsc.es/' }
  ],

  icons: {
    docs: '<svg viewBox="0 0 24 24"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22V5.5Z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22V5.5Z"/></svg>',
    api: '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3.5 6.5 8.5 6.2 8.5-6.2"/></svg>'
  }
};
