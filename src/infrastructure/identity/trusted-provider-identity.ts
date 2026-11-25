import type { ProviderIdentityPort } from '../../application/ports';

/** Adaptador padrão, sem autenticação: confia no `providerId` declarado por quem chama. Só serve dentro de uma rede confiável. */
export class TrustedProviderIdentity implements ProviderIdentityPort {
  async ensureCanActAs(): Promise<void> {}
}
