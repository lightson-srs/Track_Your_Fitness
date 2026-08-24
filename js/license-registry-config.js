/**
 * License Registry Configuration
 * 
 * This connects to the APP OWNER's Firebase project (not the customer's).
 * The _license_registry collection in this project tracks which license keys
 * are being used against which database instances.
 */
const LICENSE_REGISTRY_CONFIG = {
  apiKey: 'AIzaSyCr3rjWD-1ulmGFXoI5VW1Z258lh0WSQc4',
  authDomain: 'sivaramesalicenseusage.firebaseapp.com',
  projectId: 'sivaramesalicenseusage',
  storageBucket: 'sivaramesalicenseusage.firebasestorage.app',
  messagingSenderId: '163403716903',
  appId: '1:163403716903:web:027b71f15574293f90b102',

  // Collection name in Firestore where license usage is tracked
  registryCollection: '_license_registry'
};