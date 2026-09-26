// Configuration publique du dashboard HelioPulse.
// Cette clé doit être la clé anon/public Supabase, jamais la clé service_role.
window.HELIOPULSE_CONFIG = {
  supabaseUrl: 'https://cwlzpxclfytmchrgjpdm.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3bHpweGNsZnl0bWNocmdqcGRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MjgyNDcsImV4cCI6MjEwNTQwNDI0N30.Tasv9tjQong7p3sexLK1ofiib6EP2SD4xFE0XXkNfXk',

  // Supabase Auth identifie un compte par un email : il n'existe pas de champ
  // « identifiant ». Le formulaire accepte donc `admin` et complète avec ce
  // domaine pour former l'email du compte.
  //
  // ATTENTION — le domaine doit être REEL. Supabase refuse les adresses dont
  // le domaine ne résout pas, avec « Email address ... is invalid ». Vérifié :
  // heliopulse.local et heliopulse.app sont tous deux rejetés, alors que
  // inphb.ci et gmail.com passent. Si le compte est créé avec une vraie
  // adresse, deux solutions : la taper en entier dans le formulaire (un email
  // complet n'est jamais transformé), ou mettre son domaine ici.
  authEmailDomain: 'heliopulse.app'
};
