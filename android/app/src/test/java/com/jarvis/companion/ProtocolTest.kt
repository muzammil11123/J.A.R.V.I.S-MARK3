package com.jarvis.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's half of the protocol against vectors produced by the PC's code
 * (bridge/phone/companion.mjs). If either side changes how it computes a
 * proof or the pairing code, this fails before a real phone ever notices.
 */
class ProtocolTest {
    private val secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    private val token = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    private val pid = "pid_ABCDEFGH"
    private val dev = "dev_0123456789abcdef"
    private val nonce = "nonce_0123456789ab"
    private val fp = "ab".repeat(32)

    @Test
    fun pairingProofMatchesThePc() {
        assertEquals("ceef15e291835bd7eea885ac855801bead9c0964e2ff6980d6a4a1bbcda25418", Proto.pairProof(secret, pid, dev, nonce, fp))
    }

    @Test
    fun authProofMatchesThePc() {
        assertEquals("822441c759f87837a9bc62b8d617777d544c0e4727c2d193f53e085a642eeb4a", Proto.authProof(token, dev, nonce, fp))
    }

    @Test
    fun verificationCodeMatchesThePc() {
        assertEquals("439691", Proto.verificationCode(secret, dev, nonce))
    }

    @Test
    fun aPairingLinkFromThePcParses() {
        val uri = "jarvis-pair:eyJ2IjoxLCJwaWQiOiJwaWRfQUJDREVGR0giLCJzIjoiQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3YyIsImZwIjoiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYiIsImhvc3RzIjpbIjE5Mi4xNjguMS4zIl0sInBvcnQiOjg3OTAsIm5hbWUiOiJERVNLVE9QIiwiZGlkIjoiZGlkMTIzIn0"
        val info = PairingInfo.parse(uri)
        assertEquals(pid, info.pid)
        assertEquals(secret, info.secret)
        assertEquals(fp, info.fp)
        assertEquals(listOf("192.168.1.3"), info.hosts)
        assertEquals(8790, info.port)
    }

    @Test
    fun damagedOrForeignLinksAreRefused() {
        for (bad in listOf("https://example.com", "jarvis-pair:notbase64!!", "jarvis-pair:" + Proto.b64url("{\"v\":1}".toByteArray()))) {
            assertTrue(runCatching { PairingInfo.parse(bad) }.isFailure)
        }
    }

    @Test
    fun smsNeverGoesToEmergencyNumbersOrShortCodes() {
        for (n in listOf("112", "911", "100", "+112", "56767", "123456")) {
            assertTrue(n, SmsRules.refuse(n) != null)
        }
        for (n in listOf("+919876543210", "9876543210", "09849012345")) {
            assertEquals(n, null, SmsRules.refuse(n))
        }
        assertTrue(SmsRules.refuse("rm -rf /") != null)
    }

    @Test
    fun comparisonIsExact() {
        assertTrue(Proto.same("abc", "abc"))
        assertFalse(Proto.same("abc", "abd"))
        assertFalse(Proto.same("abc", "abcd"))
    }
}
