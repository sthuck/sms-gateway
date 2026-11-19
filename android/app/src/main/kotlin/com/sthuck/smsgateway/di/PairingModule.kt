package com.sthuck.smsgateway.di

import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceKeyStore
import com.sthuck.smsgateway.crypto.KeystoreSecretBox
import com.sthuck.smsgateway.crypto.SecretBox
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import com.sthuck.smsgateway.pairing.PairingStateAccess
import com.sthuck.smsgateway.upload.UploadScheduler
import com.sthuck.smsgateway.upload.UploadWorkScheduler
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class PairingModule {
    @Binds
    @Singleton
    abstract fun pairingCredentialsReader(store: PairingCredentialStore): PairingCredentialsReader

    @Binds
    @Singleton
    abstract fun pairingStateAccess(store: PairingCredentialStore): PairingStateAccess

    @Binds
    @Singleton
    abstract fun deviceKeyAccess(store: DeviceKeyStore): DeviceKeyAccess

    @Binds
    @Singleton
    abstract fun secretBox(box: KeystoreSecretBox): SecretBox

    @Binds
    @Singleton
    abstract fun uploadWorkScheduler(scheduler: UploadScheduler): UploadWorkScheduler
}
